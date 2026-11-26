"""Foundry Agent 認証ブリッジ API (FastAPI)。

ブラウザ拡張機能からの業務画面支援リクエストを受け取り、以下のいずれかの資格情報で
Microsoft Foundry Agent Service (Responses API) を呼び出します:
- Azure App Service (Easy Auth + OBO): サインイン中ユーザーの委任トークン (Work IQ + File Search)
- Azure App Service (Managed Identity): システム割り当てマネージド ID (File Search)
- ローカル開発環境: Azure CLI / DefaultAzureCredential
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import os
import re
import secrets
from pathlib import Path
from typing import Any

from azure.ai.projects import AIProjectClient
from azure.identity import (
    AzureCliCredential,
    ChainedTokenCredential,
    DefaultAzureCredential,
    ManagedIdentityCredential,
    OnBehalfOfCredential,
)
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger("foundry_bridge")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} が未設定です。agent-backend/.env.example を参照してください。")
    return value


PROJECT_ENDPOINT = _require_env("PROJECT_ENDPOINT")
AZURE_TENANT_ID = os.getenv("AZURE_TENANT_ID", "").strip() or None
ENTRA_CLIENT_ID = os.getenv("ENTRA_CLIENT_ID", "").strip() or None
MODEL_DEPLOYMENT_NAME = os.getenv("MODEL_DEPLOYMENT_NAME", "").strip() or "gpt-5.4-mini"
BRIDGE_PORT = int(os.getenv("BRIDGE_PORT", os.getenv("PORT", "8765")))
IS_MANAGED_IDENTITY_ENV = bool(os.getenv("IDENTITY_ENDPOINT") or os.getenv("MSI_ENDPOINT"))

WEEKDAYS_JA = ("月", "火", "水", "木", "金", "土", "日")
ALLOWED_WORKIQ_TOOLS = {"ask"}
_agent_cache: dict[str, dict[str, Any]] = {}


def get_credential() -> Any:
    if IS_MANAGED_IDENTITY_ENV:
        client_id = os.getenv("AZURE_CLIENT_ID", "").strip() or None
        return ManagedIdentityCredential(client_id=client_id) if client_id else ManagedIdentityCredential()

    cli_cred = AzureCliCredential(tenant_id=AZURE_TENANT_ID) if AZURE_TENANT_ID else AzureCliCredential()
    default_cred = (
        DefaultAzureCredential(interactive_browser_tenant_id=AZURE_TENANT_ID)
        if AZURE_TENANT_ID
        else DefaultAzureCredential()
    )
    return ChainedTokenCredential(cli_cred, default_cred)


credential = get_credential()
project_client = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=credential)
openai_client = project_client.get_openai_client()

app = FastAPI(
    title="Foundry Form Copilot Bridge API",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
)

raw_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if raw_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=raw_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Demo-Key"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(chrome-extension://[a-p]{32}|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Demo-Key"],
    )


@app.middleware("http")
async def add_security_headers(request: Request, call_next: Any) -> Response:
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


class FieldOption(BaseModel):
    value: str = Field(max_length=256)
    text: str = Field(default="", max_length=256)


class FormFieldItem(BaseModel):
    fieldKey: str = Field(min_length=1, max_length=128)
    label: str = Field(default="", max_length=256)
    type: str = Field(default="text", max_length=32)
    currentValue: str | int | float | bool | None = None
    required: bool = False
    placeholder: str = Field(default="", max_length=256)
    options: list[FieldOption] = Field(default_factory=list, max_length=200)


class AutoFillRequest(BaseModel):
    agentName: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    userMessage: str = Field(min_length=1, max_length=2000)
    conversationId: str | None = Field(default=None, max_length=256)
    previousResponseId: str | None = Field(default=None, max_length=256)
    currentDate: dict[str, str] | None = None
    pageContext: dict[str, str] | None = None
    formFields: list[FormFieldItem] = Field(default_factory=list, max_length=100)


def _inspect_agent_record(agent: Any) -> dict[str, Any]:
    versions = getattr(agent, "versions", None)
    latest = getattr(versions, "latest", None) if versions else None
    meta = getattr(latest, "metadata", None) or {}
    definition = getattr(latest, "definition", None)
    tools = getattr(definition, "tools", None) or []
    requires_delegation = any(
        getattr(t, "type", "") == "mcp" and getattr(t, "server_label", "") == "workiq"
        for t in tools
    )
    info = {
        "agentName": agent.name,
        "label": meta.get("label") or agent.name,
        "description": getattr(latest, "description", None) or "",
        "manualFile": meta.get("manual_file") or "",
        "requiresUserDelegation": requires_delegation,
    }
    _agent_cache[agent.name] = info
    return info


def get_agent_info(agent_name: str) -> dict[str, Any]:
    if agent_name in _agent_cache:
        return _agent_cache[agent_name]
    try:
        return _inspect_agent_record(project_client.agents.get(agent_name))
    except Exception:
        return {
            "agentName": agent_name,
            "label": agent_name,
            "description": "",
            "manualFile": "",
            "requiresUserDelegation": agent_name.endswith("-workiq"),
        }


def build_date_context(client_date: dict[str, str] | None) -> dict[str, str]:
    base = dt.date.today()
    if client_date and client_date.get("today"):
        try:
            base = dt.date.fromisoformat(str(client_date["today"])[:10])
        except ValueError:
            pass

    def fmt(d: dt.date) -> str:
        return f"{d.isoformat()} ({WEEKDAYS_JA[d.weekday()]})"

    return {
        "today": base.isoformat(),
        "todayFormatted": fmt(base),
        "tomorrow": (base + dt.timedelta(days=1)).isoformat(),
        "tomorrowFormatted": fmt(base + dt.timedelta(days=1)),
        "dayAfterTomorrow": (base + dt.timedelta(days=2)).isoformat(),
        "dayAfterTomorrowFormatted": fmt(base + dt.timedelta(days=2)),
        "threeDaysLater": (base + dt.timedelta(days=3)).isoformat(),
    }


def parse_agent_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", cleaned, flags=re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    else:
        brace_start = cleaned.find("{")
        brace_end = cleaned.rfind("}")
        if 0 <= brace_start < brace_end:
            cleaned = cleaned[brace_start : brace_end + 1]

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            raw_rules = parsed.get("appliedRules")
            raw_fields = parsed.get("fieldValues")
            return {
                "summary": str(parsed.get("summary") or "フォーム項目を生成しました。"),
                "appliedRules": [str(r) for r in raw_rules] if isinstance(raw_rules, list) else [],
                "fieldValues": dict(raw_fields) if isinstance(raw_fields, dict) else {},
            }
    except json.JSONDecodeError:
        pass

    return {
        "summary": text.strip() or "エージェントから応答を受信しました。",
        "appliedRules": [],
        "fieldValues": {},
    }


def extract_tool_and_citations(response: Any, manual_fallback: str) -> tuple[bool, bool, list[str]]:
    used_file_search = False
    used_work_iq = False
    citations: list[str] = []

    for item in getattr(response, "output", []) or []:
        item_type = getattr(item, "type", "")
        if item_type == "file_search_call":
            used_file_search = True
        elif item_type == "mcp_call" and getattr(item, "server_label", "") == "workiq":
            used_work_iq = True
        for content_part in getattr(item, "content", []) or []:
            for ann in getattr(content_part, "annotations", []) or []:
                filename = getattr(ann, "filename", None)
                if filename and filename not in citations:
                    citations.append(filename)

    if used_file_search and not citations and manual_fallback:
        citations.append(manual_fallback)

    return used_file_search, used_work_iq, citations


def verify_demo_key(x_demo_key: str | None) -> None:
    expected_key = os.getenv("DEMO_ACCESS_KEY", "").strip()
    if not expected_key:
        return
    provided = (x_demo_key or "").strip()
    if not provided or not secrets.compare_digest(provided.encode("utf-8"), expected_key.encode("utf-8")):
        raise HTTPException(
            status_code=401,
            detail="アクセスキーが未入力または一致しません。サイドパネル右上の設定から入力してください。",
        )


def extract_easyauth_user(request: Request) -> str | None:
    principal_name = request.headers.get("x-ms-client-principal-name")
    if principal_name:
        return principal_name

    raw_b64 = request.headers.get("x-ms-client-principal")
    if not raw_b64:
        return None

    try:
        padded = raw_b64 + "=" * (-len(raw_b64) % 4)
        decoded = json.loads(base64.b64decode(padded).decode("utf-8"))
        claims = {c.get("typ"): c.get("val") for c in decoded.get("claims", []) if isinstance(c, dict)}
        return (
            claims.get("preferred_username")
            or claims.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn")
            or claims.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress")
            or claims.get("name")
            or request.headers.get("x-ms-client-principal-id")
        )
    except Exception:
        return request.headers.get("x-ms-client-principal-id")


def get_openai_client_for_request(request: Request) -> tuple[Any, bool]:
    auth_header = request.headers.get("authorization", "")
    incoming_jwt = ""
    if auth_header.lower().startswith("bearer "):
        incoming_jwt = auth_header[7:].strip()
    elif request.headers.get("x-ms-token-aad-access-token"):
        incoming_jwt = request.headers["x-ms-token-aad-access-token"].strip()

    if incoming_jwt and IS_MANAGED_IDENTITY_ENV and AZURE_TENANT_ID and ENTRA_CLIENT_ID:
        obo_cred = OnBehalfOfCredential(
            tenant_id=AZURE_TENANT_ID,
            client_id=ENTRA_CLIENT_ID,
            client_assertion_func=lambda: credential.get_token("api://AzureADTokenExchange/.default").token,
            user_assertion=incoming_jwt,
        )
        return AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=obo_cred).get_openai_client(), True

    if not IS_MANAGED_IDENTITY_ENV and not os.getenv("DEMO_ACCESS_KEY", "").strip():
        return openai_client, True

    return openai_client, False


@app.get("/api/health")
def health() -> dict[str, Any]:
    auth_required = bool(os.getenv("DEMO_ACCESS_KEY", "").strip())
    easy_auth_enabled = os.getenv("WEBSITE_AUTH_ENABLED", "").lower() == "true"
    auth_mode = "easyauth" if easy_auth_enabled else ("passphrase" if auth_required else "none")
    return {
        "status": "ok",
        "authRequired": auth_required,
        "easyAuthEnabled": easy_auth_enabled,
        "authMode": auth_mode,
    }


@app.get("/api/agents")
def list_agents(
    request: Request,
    x_demo_key: str | None = Header(default=None, alias="X-Demo-Key"),
) -> dict[str, Any]:
    verify_demo_key(x_demo_key)
    auth_user = extract_easyauth_user(request)
    _, can_delegate_user = get_openai_client_for_request(request)
    project_name = PROJECT_ENDPOINT.rstrip("/").split("/")[-1]
    result_agents: list[dict[str, Any]] = []

    try:
        for agent in project_client.agents.list():
            info = _inspect_agent_record(agent)
            if info["requiresUserDelegation"] and not can_delegate_user:
                continue
            result_agents.append(info)
    except Exception:
        logger.exception("Foundry Agent 一覧の取得に失敗しました。")
        raise HTTPException(status_code=502, detail="Foundry Agent 一覧の取得に失敗しました。") from None

    # ユーザー委任時は Work IQ 対応エージェントを先頭に整列
    result_agents.sort(
        key=lambda a: (not a["requiresUserDelegation"] if can_delegate_user else a["requiresUserDelegation"], a["agentName"])
    )

    return {
        "projectName": project_name,
        "modelDeploymentName": MODEL_DEPLOYMENT_NAME,
        "authenticatedUser": auth_user,
        "agents": result_agents,
    }


@app.post("/api/autofill")
def autofill(
    req: AutoFillRequest,
    request: Request,
    x_demo_key: str | None = Header(default=None, alias="X-Demo-Key"),
) -> dict[str, Any]:
    verify_demo_key(x_demo_key)
    auth_user = extract_easyauth_user(request)
    if not req.userMessage.strip():
        raise HTTPException(status_code=400, detail="メッセージが空です。")

    agent_info = get_agent_info(req.agentName)
    req_openai, is_user_delegated = get_openai_client_for_request(request)

    if agent_info["requiresUserDelegation"] and not is_user_delegated:
        raise HTTPException(
            status_code=400,
            detail="Work IQ 連携エージェントの利用には Microsoft Entra ID サインイン（Easy Auth 版）が必要です。",
        )

    agent_ref = {"name": req.agentName, "type": "agent_reference"}
    payload_for_agent = {
        "currentDate": build_date_context(req.currentDate),
        "pageContext": req.pageContext or {},
        "formFields": [f.model_dump() for f in req.formFields],
        "userRequest": req.userMessage.strip(),
    }

    try:
        conv_id = req.conversationId
        if not conv_id and not req.previousResponseId:
            conv_id = req_openai.conversations.create().id

        create_kwargs: dict[str, Any] = {
            "input": json.dumps(payload_for_agent, ensure_ascii=False),
            "extra_body": {"agent_reference": agent_ref},
        }
        if req.previousResponseId:
            create_kwargs["previous_response_id"] = req.previousResponseId
        elif conv_id:
            create_kwargs["conversation"] = conv_id

        response = req_openai.responses.create(**create_kwargs)

        for _ in range(3):
            approvals = [
                {
                    "type": "mcp_approval_response",
                    "approval_request_id": item.id,
                    "approve": True,
                }
                for item in getattr(response, "output", []) or []
                if getattr(item, "type", "") == "mcp_approval_request"
                and getattr(item, "server_label", "") == "workiq"
                and getattr(item, "name", "") in ALLOWED_WORKIQ_TOOLS
            ]
            if not approvals:
                break
            response = req_openai.responses.create(
                previous_response_id=response.id,
                input=approvals,
                extra_body={"agent_reference": agent_ref},
            )
    except Exception:
        logger.exception("Foundry Agent の呼び出し中にエラーが発生しました (agent=%s)。", req.agentName)
        raise HTTPException(
            status_code=502,
            detail="Foundry Agent の呼び出しに失敗しました。エージェント名や権限設定を確認してください。",
        ) from None

    for item in getattr(response, "output", []) or []:
        if getattr(item, "type", "") == "oauth_consent_request":
            consent_link = str(getattr(item, "consent_link", "") or "")
            if consent_link.startswith("https://"):
                return {
                    "consentRequired": True,
                    "consentLink": consent_link,
                    "previousResponseId": response.id,
                    "conversationId": conv_id,
                    "agentName": req.agentName,
                    "authenticatedUser": auth_user,
                    "summary": "初回のみ Microsoft 365 (Work IQ) へのアクセス許可が必要です。",
                    "appliedRules": [],
                    "fieldValues": {},
                    "usedFileSearch": False,
                    "usedWorkIq": False,
                    "citations": [],
                }

    output_text = getattr(response, "output_text", "") or ""
    parsed = parse_agent_json(output_text)
    used_file_search, used_work_iq, citations = extract_tool_and_citations(
        response, agent_info.get("manualFile", "")
    )

    return {
        "consentRequired": False,
        "conversationId": conv_id,
        "agentName": req.agentName,
        "authenticatedUser": auth_user,
        "summary": parsed["summary"],
        "appliedRules": parsed["appliedRules"],
        "fieldValues": parsed["fieldValues"],
        "usedFileSearch": used_file_search,
        "usedWorkIq": used_work_iq,
        "citations": citations,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=BRIDGE_PORT)

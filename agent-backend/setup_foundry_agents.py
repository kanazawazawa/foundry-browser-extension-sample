"""Microsoft Foundry Agent セットアップスクリプト。

manuals/ 配下の HTML マニュアルを Vector Store に登録し、各社分の Prompt Agent を作成します:
- 基本エージェント (File Search のみ): expense-agent-sakura / expense-agent-yamato
- Work IQ 連携エージェント (WORKIQ_CONNECTION_NAME 設定時): expense-agent-sakura-workiq / expense-agent-yamato-workiq

会社ごとの規定の差異はすべて File Search のマニュアルから取得します。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import FileSearchTool, MCPTool, PromptAgentDefinition
from azure.identity import AzureCliCredential, ChainedTokenCredential, DefaultAzureCredential
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
MANUALS_DIR = BASE_DIR.parent / "manuals"
WORKIQ_MCP_URL = "https://workiq.svc.cloud.microsoft/mcp"

load_dotenv(BASE_DIR / ".env")


def _require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} が未設定です。agent-backend/.env.example を .env にコピーして設定してください。")
    return value


PROJECT_ENDPOINT = _require_env("PROJECT_ENDPOINT")
AZURE_TENANT_ID = os.getenv("AZURE_TENANT_ID", "").strip() or None
MODEL_DEPLOYMENT_NAME = os.getenv("MODEL_DEPLOYMENT_NAME", "").strip() or "gpt-5.4-mini"
WORKIQ_CONNECTION_NAME = os.getenv("WORKIQ_CONNECTION_NAME", "").strip()

def build_instructions(*, use_workiq: bool) -> str:
    workiq_rule = (
        "- 要望に具体的な日時・対象・目的が含まれない場合や、予定・メール・チャットの確認が必要な場合は、"
        "`workiq` の `ask` ツール（Asia/Tokyo 基準）でユーザーの Microsoft 365 情報を確認する。\n"
        if use_workiq
        else ""
    )
    return f"""Web画面のフォーム項目定義（formFields）とユーザーの要望（userRequest）から、各項目に入力する値を生成するアシスタントです。

方針:
{workiq_rule}- 必ず `file_search` で添付マニュアルを検索し、推測せずマニュアルの規定・既定値・計算式・書式に従う。
- 最小限の要望でもマニュアルの既定ルールを適用し、該当する全項目を埋める。条件変更時は連動する項目もすべて再計算して更新する。

型・形式:
- `fieldValues` のキーは `formFields` の `fieldKey` と一致させる。
- `select` / `radio` は `options` 内の `value` を返す（表示テキスト不可）。
- `checkbox` は真偽値（`true` / `false`）、`number` は数値のみ、`date` は `currentDate` 基準の `"YYYY-MM-DD"` を返す。

出力（JSONオブジェクトのみ、コードブロック不要）:
{{"summary": "入力内容の簡潔な要約", "appliedRules": ["適用した根拠1", "適用した根拠2"], "fieldValues": {{"<fieldKey>": "<値>"}}}}"""

AGENT_SPECS: list[dict[str, Any]] = [
    {
        "agent_name": "expense-agent-sakura",
        "display_label": "株式会社さくらテック（Sakura Expense）",
        "description": "さくらテックの国内出張・経費申請ガイドライン（HTML）を参照する業務画面支援エージェント",
        "vector_store_name": "vs-sakura-expense-manual",
        "manual_file": MANUALS_DIR / "sakura-tech-expense-manual.html",
    },
    {
        "agent_name": "expense-agent-yamato",
        "display_label": "大和重工ロジスティクス（J-Keihi）",
        "description": "大和重工ロジスティクスのJ-Keihi旅費伝票入力標準手引（HTML）を参照する業務画面支援エージェント",
        "vector_store_name": "vs-yamato-jkeihi-manual",
        "manual_file": MANUALS_DIR / "yamato-jkeihi-travel-manual.html",
    },
]


def get_credential() -> ChainedTokenCredential:
    cli_cred = AzureCliCredential(tenant_id=AZURE_TENANT_ID) if AZURE_TENANT_ID else AzureCliCredential()
    default_cred = (
        DefaultAzureCredential(interactive_browser_tenant_id=AZURE_TENANT_ID)
        if AZURE_TENANT_ID
        else DefaultAzureCredential()
    )
    return ChainedTokenCredential(cli_cred, default_cred)


def ensure_vector_store(openai_client: Any, existing_by_name: dict[str, Any], vs_name: str, manual_path: Path) -> str:
    if not manual_path.exists():
        raise FileNotFoundError(f"マニュアルファイルが見つかりません: {manual_path}")

    if vs_name in existing_by_name:
        vector_store = existing_by_name[vs_name]
        print(f"Reusing vector store '{vs_name}' ({vector_store.id})")
        if list(openai_client.vector_stores.files.list(vector_store_id=vector_store.id)):
            return vector_store.id

    print(f"Creating vector store '{vs_name}' and uploading '{manual_path.name}'...")
    vector_store = openai_client.vector_stores.create(name=vs_name)
    with manual_path.open("rb") as handle:
        vs_file = openai_client.vector_stores.files.upload_and_poll(
            vector_store_id=vector_store.id,
            file=(manual_path.name, handle, "text/html"),
        )
    print(f"  -> Indexed {manual_path.name} (status={vs_file.status}, file_id={vs_file.id})")
    return vector_store.id


def main() -> None:
    print(f"Project Endpoint : {PROJECT_ENDPOINT}")
    print(f"Model Deployment : {MODEL_DEPLOYMENT_NAME}")
    print(f"Work IQ MCP      : {WORKIQ_CONNECTION_NAME or '(disabled - File Search only)'}")

    project = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=get_credential())
    openai_client = project.get_openai_client()
    existing_stores = {vs.name: vs for vs in openai_client.vector_stores.list() if vs.name}

    for spec in AGENT_SPECS:
        manual_path: Path = spec["manual_file"]
        vs_id = ensure_vector_store(openai_client, existing_stores, spec["vector_store_name"], manual_path)

        base_agent = project.agents.create_version(
            agent_name=spec["agent_name"],
            definition=PromptAgentDefinition(
                model=MODEL_DEPLOYMENT_NAME,
                instructions=build_instructions(use_workiq=False),
                tools=[FileSearchTool(vector_store_ids=[vs_id])],
            ),
            description=spec["description"],
            metadata={
                "label": spec["display_label"],
                "manual_file": manual_path.name,
            },
        )
        print(f"  -> Base Agent '{base_agent.name}' ready (version={base_agent.version})")

        if WORKIQ_CONNECTION_NAME:
            workiq_tool = MCPTool(
                server_label="workiq",
                server_url=WORKIQ_MCP_URL,
                project_connection_id=WORKIQ_CONNECTION_NAME,
                allowed_tools=["ask"],
                require_approval="never",
            )
            workiq_agent = project.agents.create_version(
                agent_name=f"{spec['agent_name']}-workiq",
                definition=PromptAgentDefinition(
                    model=MODEL_DEPLOYMENT_NAME,
                    instructions=build_instructions(use_workiq=True),
                    tools=[FileSearchTool(vector_store_ids=[vs_id]), workiq_tool],
                ),
                description=f"{spec['description']}（Work IQ MCP 連携）",
                metadata={
                    "label": f"{spec['display_label']} ＋ Work IQ",
                    "manual_file": manual_path.name,
                },
            )
            print(f"  -> Work IQ Agent '{workiq_agent.name}' ready (version={workiq_agent.version})")


if __name__ == "__main__":
    main()

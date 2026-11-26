# 既存 Web システムへの外付け AI 支援 — ブラウザ拡張 × Microsoft Foundry Agent

ソースコードに手を入れられないレガシー業務システムやパッケージ製品に対し、**システム本体を無改修のまま**、ブラウザ拡張機能のサイドパネルから **Microsoft Foundry Agent Service** を重ね合わせるサンプルです。

業務規程やコード体系は拡張機能やプロンプトには埋め込まず、エージェント側の **File Search**（マニュアル・規程集）や **Work IQ MCP**（Microsoft 365 の予定・メール）に分離します。画面構造と業務知識を切り離すことで、UI もルールも異なる複数の業務システムに対して同一の拡張機能を横展開できます。

本リポジトリでは一例として「社内規程に基づく旅費・経費伝票の起票支援」を実装していますが、同じ構成で以下のような用途へ拡張できます。

- 難解な伝票コード・勘定科目・画面エラーのサイドパネル上での解説・入力ナビゲーション
- 申請ボタンを押す前の入力内容に対する社内規程・コンプライアンス観点での事前チェック
- 請求書・見積書・領収書などの PDF や画像をサイドパネルに添付し、OCR／文書解析と社内規程の照合を組み合わせて既存画面へ転記する入力補助
- Outlook の予定表やメール（Work IQ）の文脈を踏まえた周辺業務システムへの起票・転記補助

```text
ブラウザ (Edge / Chrome)
 ├── 業務 Web システム A / B     (本体無改修・DOM の項目構造を動的に抽出・反映)
 └── ブラウザ拡張機能            ──> 中継 API (FastAPI) ──> Foundry Agent Service
                                                              ├── File Search (社内規程・操作手引)
                                                              └── Work IQ MCP (M365 予定・メール / 任意)
```

| ディレクトリ | 内容 |
| --- | --- |
| [web-apps/](web-apps) | 画面構造・コード体系が異なる2社分のモック業務 Web アプリ（モダン SaaS 風 / 基幹 ERP 風） |
| [manuals/](manuals) | File Search に登録する各社の社内規程・伝票入力手引（HTML） |
| [agent-backend/](agent-backend) | Foundry Agent セットアップスクリプトと認証中継 API（FastAPI） |
| [browser-extension/](browser-extension) | サイドパネル型ブラウザ拡張機能（ローカル開発・アクセスキー認証向け） |
| [browser-extension-easyauth/](browser-extension-easyauth) | Microsoft Entra ID (OAuth 2.0 PKCE) + App Service Easy Auth 対応版の拡張機能 |
| [infra/](infra) | Azure App Service デプロイ用 Bicep テンプレート |

## 前提

- Microsoft Foundry プロジェクトとモデルのデプロイ（既定は `gpt-5.4-mini`）
  - セットアップ実行ユーザーに Foundry プロジェクトの **Foundry User** ロールとストレージへのアップロード権限があること
- Python 3.12 以降、Node.js 22 以降、Azure CLI (`az login` 済み)
- Microsoft Edge または Google Chrome

## セットアップ（ローカル実行）

### 1. Foundry Agent と規程マニュアルの登録

[agent-backend/.env.example](agent-backend/.env.example) を `agent-backend/.env` にコピーし、`PROJECT_ENDPOINT` を設定します。

```powershell
cd agent-backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python setup_foundry_agents.py
```

2社分の Vector Store が作成され、[manuals/](manuals) 配下の HTML マニュアルを参照する `expense-agent-sakura` と `expense-agent-yamato` が作成されます（両エージェントのシステムプロンプトは共通です）。マニュアルは Foundry ポータル画面から直接差し替えることもできます。

### 2. Web アプリと中継 API の起動

Windows ではルートの `start-demo.cmd` で一括起動できます。手動で起動する場合は次のとおりです。

```powershell
# ターミナル 1: モック業務 Web アプリ (ランチャー :3000 / A社 :3001 / B社 :3002)
node web-apps/server.mjs

# ターミナル 2: Foundry 中継 API (:8765)
agent-backend\.venv\Scripts\python -m uvicorn bridge_server:app --app-dir agent-backend --port 8765
```

### 3. ブラウザ拡張機能の読み込み

1. Edge (`edge://extensions`) または Chrome (`chrome://extensions`) を開き、**開発者モード** を有効にします。
2. **展開して読み込み** から [browser-extension/](browser-extension) フォルダを選択します。
3. <http://localhost:3000> から A社（`:3001`）または B社（`:3002`）の画面を開き、拡張機能アイコンをクリックしてサイドパネルを開きます。

サイドパネルで対象エージェントを選び、「`明日、大阪へ出張します`」や「`1泊2日に変更してください`」と送信すると、各社マニュアルの規程（出発駅、指定手配区分、運賃、日当、金額閾値に応じた決裁ルート等）に沿って起票内容が反映されます。

> **誤送信防止（対象サイト制限）**: 拡張機能は `activeTab` 権限を持たず、許可された業務アプリ（既定では `localhost:3001` / `3002`、`127.0.0.1:3001` / `3002`、`https://*.azurewebsites.net`、ただし中継 API 自体は除外）以外のタブでは画面スキャン・AI 送信・入力欄を自動ブロックします（設定・サインイン用のサイドパネル表示のみ可能です）。ローカルの `config.local.json`（`.gitignore` 対象）に `"allowedOrigins": ["https://<対象FQDN>"]` を指定すると、さらに特定の業務アプリ FQDN のみに限定できます。

## 認証構成のバリエーションと Azure デプロイ（任意）

中継 API を Azure App Service に配置する場合は、[infra/main.bicep](infra/main.bicep)（パラメータ例は [infra/main.bicepparam.example](infra/main.bicepparam.example)）を使用できます。用途に応じて2つの構成を用意しています。

1. **アクセスキー方式（[browser-extension/](browser-extension)）**
   - 環境変数 `DEMO_ACCESS_KEY` を設定すると、`X-Demo-Key` ヘッダーが一致するリクエストのみを受け付けます。中継 API から Foundry へは System-Assigned Managed Identity で接続します。
2. **Entra ID Easy Auth + OBO 方式（[browser-extension-easyauth/](browser-extension-easyauth)）**
   - 拡張機能側で `chrome.identity.launchWebAuthFlow`（OAuth 2.0 PKCE）によりユーザートークンを取得し、App Service の組み込み認証（Easy Auth v2）で検証します。
   - Entra アプリ登録の「シングルページ アプリケーション (SPA)」リダイレクト URI には、サイドパネルの設定欄に表示される `https://<extension-id>.chromiumapp.org/callback` を登録します。
   - **Work IQ MCP**（`https://workiq.svc.cloud.microsoft/mcp`）を Foundry プロジェクトに接続し、`.env` の `WORKIQ_CONNECTION_NAME` に指定して `setup_foundry_agents.py` を実行すると、基本エージェントとは別名で Work IQ 連携エージェント（`expense-agent-sakura-workiq` / `expense-agent-yamato-workiq`）が追加作成されます。Easy Auth 版からはサインイン中ユーザーの委任トークン（On-Behalf-Of）を通じて Outlook の予定表やメールから出張予定を読み取って起票できます（アクセスキー方式の一覧には基本エージェントのみ表示されます）。詳細は [Connect agents to Microsoft 365 with Work IQ](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/work-iq) を参照してください。

## 制約事項（サンプルの位置づけ）

検証・デモを目的とした最小構成のサンプルであり、そのまま本番環境へ適用することは想定していません。

- 独自 UI コンポーネント（`<select>` を使わない仮想コンボボックス等）、Shadow DOM、クロスオリジン `<iframe>`、Canvas 描画画面、Edge の IE モード画面には未対応です。
- 本番運用に必要なレート制限、監査ログ、厳格なテナント・ロール認可、リトライ制御は省略しています。

## ライセンス

[MIT](LICENSE)

本リポジトリの内容は個人の見解であり、所属する組織の見解ではありません。

# LINE + Gemini AI 個人減重健康管理系統

依《LINE + Gemini AI 個人健康管理系統｜完整功能規格書 1.0》實作。
LINE 負責日常紀錄與提醒，Gemini 負責照片辨識、飲食估算與報告解讀，Google Sheets 存資料，Google Drive 存照片，Web Dashboard 看長期趨勢、修正資料、管理排程。

```
LINE 官方帳號 ──Webhook──▶ Cloud Run (Node.js / Express) ──▶ Google Sheets（15 張表）
     ▲                         │   │                        └▶ Google Drive（照片，不公開）
     └──── Push 提醒／報告 ─────┘   └──▶ Gemini API（辨識／估算／摘要）
Cloud Scheduler ─每 5 分鐘─▶ /jobs/tick      Web Dashboard（同一個 Cloud Run，Google 登入）
```

## 專案結構

```
backend/
  server.js                 Express 入口（/webhook、/jobs/tick、/api、Dashboard 靜態檔）
  line/                     webhook.js（簽章驗證）、parser.js（文字指令）、message-handler.js（對話流程）、rich-menu.js
  gemini/                   client.js（REST）、image-analysis.js（體脂）、meal-analysis.js（飲食）、report-analysis.js（報告／問答）
  services/                 weight / body / meal / exercise / injection / goal / pending / report-calc / report-service
  scheduler/                reminder-job.js（提醒＋補提醒＋逾期）、report-jobs.js（日／週／月報告推播）
  database/                 schema.js（欄位定義）、sheets-service.js（Sheets／記憶體兩種實作）、drive-service.js
  api/                      dashboard-api.js、auth.js（Google 登入）
dashboard/                  index.html + js/（原生 ES Modules + Chart.js）
scripts/                    setup-sheets.js、setup-rich-menu.js、get-refresh-token.js、make-rich-menu-image.py、seed-demo.js
test/                       node:test（解析、報告計算、完整對話與排程流程）
```

## 本機試跑（不需任何雲端帳號）

```bash
npm install
npm test                                   # 15 個測試
STORAGE=memory SEED_DEMO=1 DEV_AUTH_USER_ID=U_demo npm run dev
# 開啟 http://localhost:8080 → 直接看到含 40 天示範資料的 Dashboard
```

Windows PowerShell：`$env:STORAGE="memory"; $env:SEED_DEMO="1"; $env:DEV_AUTH_USER_ID="U_demo"; npm run dev`

## 正式部署步驟

### 1. Google Cloud
1. 建立專用 GCP 專案，啟用 **Google Sheets API、Google Drive API、Cloud Run、Cloud Scheduler、Secret Manager**。
2. OAuth 同意畫面：使用者類型「外部」，加入自己的帳號為測試使用者，然後按 **「發布應用程式」改為正式版**（停留在「測試」狀態的 refresh token 7 天就會失效）。
3. 建立兩個 OAuth 用戶端 ID：
   - **電腦版應用程式** → `GOOGLE_OAUTH_CLIENT_ID / SECRET`，用來存取 Sheets／Drive
   - **網頁應用程式**（已授權 JavaScript 來源填 Cloud Run 網址）→ `DASHBOARD_GOOGLE_CLIENT_ID`
4. 複製 `.env.example` 為 `.env` 填好後：
   ```bash
   node --env-file=.env scripts/get-refresh-token.js   # 取得 GOOGLE_OAUTH_REFRESH_TOKEN
   node --env-file=.env scripts/setup-sheets.js        # 建立試算表（15 張表）與照片資料夾，印出 ID
   ```
   > 為什麼不用 Service Account？個人 Gmail 的 Service Account 沒有 Drive 儲存空間，無法上傳照片。若使用 Google Workspace 共用雲端硬碟，可不填 OAuth 三個值，改用 Cloud Run 服務帳號（ADC），並把試算表分享給服務帳號。

### 2. LINE
1. LINE Developers 建立 Messaging API Channel，取得 Channel secret 與 Channel access token。
2. LINE Official Account Manager：關閉「自動回應訊息」，開啟「Webhook」。
3. Webhook URL 設為 `https://<Cloud Run 網址>/webhook`，部署後按「Verify」。

### 3. Gemini
Google AI Studio 建立 API Key → `GEMINI_API_KEY`。模型由 `GEMINI_MODEL` 設定（預設 `gemini-2.5-flash`），上線前請依官方文件確認可用模型名稱。

### 4. 部署 Cloud Run
```bash
# 金鑰放 Secret Manager（範例）
printf '%s' "$LINE_CHANNEL_SECRET" | gcloud secrets create line-channel-secret --data-file=-
# …其餘 LINE_CHANNEL_ACCESS_TOKEN、GEMINI_API_KEY、GOOGLE_OAUTH_*、SESSION_SECRET、JOB_SECRET 同理

gcloud run deploy health --source . --region asia-east1 --allow-unauthenticated \
  --no-cpu-throttling --max-instances 1 --memory 512Mi \
  --set-env-vars STORAGE=sheets,TZ_DEFAULT=Asia/Taipei,SPREADSHEET_ID=...,DRIVE_FOLDER_ID=...,ALLOWED_EMAILS=you@gmail.com,DASHBOARD_GOOGLE_CLIENT_ID=...,BASE_URL=https://... \
  --set-secrets LINE_CHANNEL_SECRET=line-channel-secret:latest,LINE_CHANNEL_ACCESS_TOKEN=...,GEMINI_API_KEY=...,GOOGLE_OAUTH_CLIENT_ID=...,GOOGLE_OAUTH_CLIENT_SECRET=...,GOOGLE_OAUTH_REFRESH_TOKEN=...,SESSION_SECRET=...,JOB_SECRET=...
```
- `--no-cpu-throttling`：Webhook 先回 200 再於背景處理（AI 辨識可能 10–30 秒），需要 CPU 持續配置。
- `--max-instances 1`：Sheets 不是交易型資料庫，單一實例可避免重複寫入與重複推播。

### 5. 排程與選單
```bash
gcloud scheduler jobs create http health-tick --location asia-east1 \
  --schedule "*/5 * * * *" --time-zone "Asia/Taipei" \
  --uri "https://<Cloud Run 網址>/jobs/tick" --http-method POST \
  --headers "X-Job-Secret=<JOB_SECRET>"

node --env-file=.env scripts/setup-rich-menu.js        # 上傳 assets/rich-menu.png 並設為預設選單
```
最後在 LINE 加入官方帳號好友 → 系統自動建立 Settings 與 7 項預設排程 → 用 Google 登入 Dashboard（第一次登入會自動綁定唯一的 LINE 使用者）。

## LINE 指令

| 輸入 | 動作 |
|---|---|
| `59.8`／`上午 59.8`／`下午 59.5` | 體重；未指定時依「上午／下午判斷時段」設定，時段外會詢問 |
| `補登 11/08 上午 59.8 08:10` | 補登（標記為補登） |
| 上傳照片 | 詢問「體脂計／餐點」；從選單「體脂測量」或體脂提醒後上傳則直接辨識 |
| `施打 2.5mg`／`施打 藥名 2.5mg`／`未施打`／`延後施打` | 施打紀錄（確認後寫入） |
| `午餐：水煮蛋2顆、蛋白飲一瓶` | Gemini 估算營養，確認後寫入 |
| `騎車 60 分鐘 15 公里`／`重訓 45 分鐘 高強度` | 運動；無可靠消耗資料時以 MET 估算並標示「估算」 |
| `修改 體脂率 28.4`／`修改 劑量 5`／`修改 熱量 400` | 確認前修改待確認的數值 |
| `今日報告`／`本週報告`／`本月報告`／`我的目標`／`最近30天`／`今日待辦`／`今日營養` | 查詢 |
| `目標 體重 55 2027/03/31` | 設定目標 |
| `暫停提醒`／`暫停提醒3天`／`恢復提醒` | 提醒開關 |

## 規格對應的關鍵規則（已實作並有測試）
- 重複輸入同日同時段 → 詢問「覆蓋原紀錄／新增一筆」，覆蓋時 Audit_Log 保留前後值。
- 體重超出合理範圍拒絕；與上一筆差距超過門檻需再確認。
- 照片辨識、飲食估算、施打、運動一律「待確認」→ 按確認才寫入；照片看不清楚的欄位留空。
- 提醒：event_id = `task_id:日期:first/repeat/report` 防重複；完成後不再補提醒；補提醒只一次；超過逾期分鐘標記逾期；推播失敗重試 3 次並寫入 System_Log、通知管理者。
- 報告：差異／平均由程式計算（`report-calc.js`），Gemini 只解讀；上午比上午、下午比下午；缺值顯示「無資料」，未記錄飲食不視為 0；週日未測體脂標示「本週未測量」；體脂率差異以百分點表示；Gemini 失敗時報告照常送出（無摘要）。
- 原始紀錄不刪除（status = 已刪除）；所有讀寫依 user_id 隔離；Drive 照片不公開，Dashboard 經後端代理顯示。

## 與規格書的差異（設計決定）
| 項目 | 說明 |
|---|---|
| 多 3 張系統表 | `Pending_Action`（待確認動作，跨實例保存對話狀態）、`Audit_Log`（修改前後值）、`System_Log`（錯誤紀錄） |
| 提醒時間存放位置 | 規格 Settings 中的 morning_reminder 等欄位改由 **Task_Schedule** 統一管理（含報告時間），避免兩處設定不一致；Dashboard「作業排程」可調整 |
| Task_Schedule 新增欄位 | `task_type`（決定完成判斷方式）、`day_of_month`、`overdue_minutes`、`message` |
| `measure_time` 定義 | 使用者指定的測量時間；未指定時為輸入時間；補登未指定時間則留空。資料建立時間另存 `created_at` |
| 同時段多筆 | 報告採該時段最後輸入的一筆 |
| 即時查詢報告 | LINE 查詢尚未產生的報告時即時計算但不寫入 Report_Log，避免影響排程推播 |
| 施打提醒 | 預設建立但**停用**，請依醫囑在 Dashboard 設定星期與時間後啟用 |

## 注意事項
- **LINE 訊息額度**：回覆（reply）免費，推播（push）計入每月額度。每日 2 次體重提醒＋補提醒＋每日報告，一個月約 100–150 則，請確認方案額度；可在 Dashboard 停用不需要的補提醒。
- **Sheets 效能**：讀取有 4 秒快取、更新採 batchUpdate。資料量大或多人使用時，`database/sheets-service.js` 介面可替換為 PostgreSQL 實作。
- 系統是紀錄與一般資訊輔助工具，不提供藥物劑量或施打頻率建議，不替代醫師診療。

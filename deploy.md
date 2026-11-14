# 雲端部署（Firebase Hosting + Cloud Run + Cloud Tasks + Cloud Scheduler）

部署完成後，LINE Bot、提醒排程與 Dashboard 都在 Google Cloud 上運作，本機關機也能使用。

```
LINE ──Webhook──▶ Cloud Run /webhook ──(驗證簽章)──▶ Cloud Tasks 佇列 ──OIDC──▶ Cloud Run /tasks/line-event
                                                                                 ├▶ Google Sheets / Drive
                                                                                 └▶ Gemini API
Cloud Scheduler ──每 5 分鐘、OIDC──▶ Cloud Run /jobs/tick（提醒推播）
瀏覽器 ──▶ Firebase Hosting（dashboard/）──/api/**──▶ Cloud Run（驗證 Firebase ID token + 白名單）
```

| 部分 | 放在哪裡 |
|---|---|
| `dashboard/` 網頁 | Firebase Hosting：`https://<專案ID>.web.app` |
| `backend/`（API、LINE webhook、排程端點） | Cloud Run 服務 `health`（asia-east1），用專案內的 `Dockerfile` 打包 |
| LINE 事件處理 | Cloud Tasks 佇列 `line-events`（同時只派送 1 個，依序處理） |
| 提醒排程 | Cloud Scheduler 工作 `health-tick` |
| LINE / Gemini / Google OAuth 金鑰 | Secret Manager，部署時以環境變數注入 |

## 安全機制

1. **Dashboard 登入**：Firebase Authentication 的 Google 登入。後端只接受 `ALLOWED_EMAILS` 白名單內、email 已驗證、且以 Google 登入的帳號，其他帳號就算登入成功也會被擋（403）。
2. **Dashboard API**：每個 `/api/*` 請求都驗證 `Authorization: Bearer <Firebase ID token>`，沒有或無效回 401。直接打 API 拿不到資料。
3. **LINE webhook**：以 Channel secret 驗證 `x-line-signature`，簽章不符回 401，不會放進佇列。
4. **排程／佇列端點**：`/jobs/tick`、`/tasks/line-event` 只接受由 `health-invoker` 服務帳號簽發、audience 為 Cloud Run 網址的 OIDC token，其他人呼叫一律 401。

> Cloud Run 設為「允許未經驗證的呼叫」，是因為 LINE 和 Firebase Hosting 需要呼叫得到它；上面四層驗證都在程式內進行。

---

## 一、主控台手動步驟（只需做一次）

1. **Firebase 主控台** → 新增專案（本專案：名稱 `dora-health`，**專案 ID `dora-health-6a02c`**）。建立時「Gemini in Firebase」與「Google Analytics」可關閉。
2. **升級 Blaze 方案**（Firebase 主控台左下角）。
3. **預算警示**：Google Cloud 主控台 → 帳單 → 預算與快訊 → 建立預算，金額例如 NT$100，門檻 50% / 90% / 100% 寄信通知。
4. **Authentication** → 開始使用 → Sign-in method → 啟用 **Google**。
5. **專案設定 → 一般 → 你的應用程式 → 新增網頁應用程式（`</>`）**，暱稱隨意，不需要勾選 Hosting 以外的選項。這一步是讓 Hosting 的 `/__/firebase/init.json` 有設定可以提供。
6. **Sheets／Drive 用的 OAuth 用戶端**（Google Cloud 主控台，同一個專案）：
   1. API 和服務 → 啟用 **Google Sheets API**、**Google Drive API**。
   2. Google Auth Platform（OAuth 同意畫面）→ 使用者類型「外部」→ 測試使用者加入自己的 Gmail → **發布應用程式（改為正式版）**。停留在「測試」狀態的 refresh token 7 天就會失效。
   3. 用戶端 → 建立 OAuth 用戶端 ID → 類型「**電腦版應用程式**」→ 取得 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`。
   > 如果你本機已經有一組可用的 OAuth 用戶端與 refresh token（之前就在用的），可以直接沿用，跳過這一步。
7. **Gemini API Key**：Google AI Studio → Get API key。**建議建在「沒有綁定帳單」的專案**，才會使用免費方案；建在 Blaze 專案會依用量計費。
8. **安裝工具**：
   - Google Cloud CLI：<https://cloud.google.com/sdk/docs/install>，裝好後執行 `gcloud auth login`
   - Firebase CLI：`npm install -g firebase-tools`，然後 `firebase login`（做 C:\JS 時應該已經裝過）

---

## 二、準備 .env（本機，不會被 commit）

```bash
cp .env.example .env
```

填入 `.env`：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`GEMINI_API_KEY`、`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`ALLOWED_EMAILS`（你的 Gmail）、`ADMIN_LINE_USER_ID`（選填）。

接著取得 refresh token、建立試算表（已經有試算表與照片資料夾的話跳過 `setup-sheets.js`，直接填既有的 ID）：

```bash
node --env-file=.env scripts/get-refresh-token.js   # 印出 GOOGLE_OAUTH_REFRESH_TOKEN，填回 .env
node --env-file=.env scripts/setup-sheets.js        # 印出 SPREADSHEET_ID、DRIVE_FOLDER_ID，填回 .env
```

---

## 三、部署指令

**以下指令請在 Git Bash 執行**（在專案資料夾 `C:\JS_P\Health`）。每次開新的終端機都要先執行第 0 步設定變數。

### 0. 設定變數

```bash
source <(tr -d '\r' < .env)          # 先讀入 .env（SPREADSHEET_ID、金鑰等），下面的值才不會被 .env 覆蓋
PROJECT=dora-health-6a02c            # Firebase 專案 ID
REGION=asia-east1
SA_RUN=health-run@$PROJECT.iam.gserviceaccount.com
SA_INVOKER=health-invoker@$PROJECT.iam.gserviceaccount.com
export CLOUDSDK_CORE_PROJECT=$PROJECT   # 只影響這個終端機，不改 gcloud 全域預設專案（其他專案不受影響）
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SERVICE_URL=https://health-$PROJECT_NUMBER.$REGION.run.app
echo "$SERVICE_URL"
```

> `.env` 裡的 `SERVICE_URL` 也請填成同一個網址（本專案為 `https://health-1084871097089.asia-east1.run.app`）。

`.firebaserc` 裡的 `default` 也要改成同一個專案 ID。

### 1. 啟用 API（一次）

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com \
  sheets.googleapis.com drive.googleapis.com
```

### 2. 服務帳號與權限（一次）

```bash
# Cloud Run 執行身分：讀取金鑰、建立 Cloud Tasks 任務
gcloud iam service-accounts create health-run --display-name "Health Cloud Run"
# Cloud Scheduler / Cloud Tasks 呼叫後端時用的身分（只用來簽 OIDC token，不需要其他權限）
gcloud iam service-accounts create health-invoker --display-name "Health invoker"

gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$SA_RUN" --role roles/secretmanager.secretAccessor --condition=None
gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$SA_RUN" --role roles/cloudtasks.enqueuer --condition=None
# 讓 Cloud Run 建立任務時可以指定 health-invoker 簽發 OIDC token
gcloud iam service-accounts add-iam-policy-binding $SA_INVOKER --member "serviceAccount:$SA_RUN" --role roles/iam.serviceAccountUser
```

### 3. 金鑰存入 Secret Manager

第一次建立（從 `.env` 讀取，不會出現在指令紀錄中）：

```bash
for NAME in LINE_CHANNEL_SECRET LINE_CHANNEL_ACCESS_TOKEN GEMINI_API_KEY \
            GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REFRESH_TOKEN; do
  printf '%s' "${!NAME}" | gcloud secrets create "$NAME" --replication-policy=automatic --data-file=-
done
```

之後要更換某個金鑰：先改 `.env`，再執行（以 Gemini 為例），然後重新部署（第 5 步）讓新版本生效：

```bash
printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
```

### 4. Cloud Tasks 佇列（一次）

```bash
gcloud tasks queues create line-events --location $REGION \
  --max-concurrent-dispatches 1 --max-dispatches-per-second 5 \
  --max-attempts 3 --min-backoff 5s
```

### 5. 部署 Cloud Run（第一次與每次更新後端都用這個）

```bash
gcloud run deploy health --source . --region $REGION \
  --service-account $SA_RUN --allow-unauthenticated \
  --max-instances 1 --memory 512Mi --cpu 1 --timeout 300 \
  --set-env-vars "^;^NODE_ENV=production;STORAGE=sheets;TZ_DEFAULT=Asia/Taipei;GCP_PROJECT_ID=$PROJECT;SERVICE_URL=$SERVICE_URL;INVOKER_SA_EMAIL=$SA_INVOKER;TASKS_QUEUE=line-events;TASKS_LOCATION=$REGION;BASE_URL=https://$PROJECT.web.app;SPREADSHEET_ID=$SPREADSHEET_ID;DRIVE_FOLDER_ID=$DRIVE_FOLDER_ID;ALLOWED_EMAILS=$ALLOWED_EMAILS;ADMIN_LINE_USER_ID=$ADMIN_LINE_USER_ID;GEMINI_MODEL=gemini-3.5-flash" \
  --set-secrets "LINE_CHANNEL_SECRET=LINE_CHANNEL_SECRET:latest,LINE_CHANNEL_ACCESS_TOKEN=LINE_CHANNEL_ACCESS_TOKEN:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_OAUTH_CLIENT_ID=GOOGLE_OAUTH_CLIENT_ID:latest,GOOGLE_OAUTH_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET:latest,GOOGLE_OAUTH_REFRESH_TOKEN=GOOGLE_OAUTH_REFRESH_TOKEN:latest"
```

- 第一次執行會詢問是否建立 Artifact Registry 存放區，回答 `Y`。
- **不要**加 `--no-cpu-throttling` 或 `--min-instances`：會改成整天持續計費。LINE 事件已改由 Cloud Tasks 在請求內處理，不需要背景 CPU。
- `--max-instances 1`：Sheets 不是交易型資料庫，單一執行個體可避免重複寫入與重複推播。
- `^;^` 是把分隔符號改成分號，因為 `ALLOWED_EMAILS` 裡可能有逗號。

確認網址與第 0 步的 `SERVICE_URL` 相同：

```bash
gcloud run services describe health --region $REGION --format='value(status.url)'
curl -s $SERVICE_URL/health                                          # {"ok":true,"storage":"sheets"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST $SERVICE_URL/jobs/tick   # 401（沒有 OIDC token 被擋）
```

> 如果 `describe` 顯示的是另一種網址（例如 `https://health-xxxxxxxx-de.a.run.app`），兩種網址都能用，但 OIDC audience 必須一致：把第 0 步的 `SERVICE_URL` 改成 `describe` 顯示的網址，重新執行第 5 步。

### 6. 映像檔自動清理（一次，第 5 步之後）

每次部署會留下一份容器映像檔，免費額度只有 0.5 GB。只保留最近 2 份：

```bash
cat > /tmp/cleanup.json <<'EOF'
[
  { "name": "keep-recent", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 2 } },
  { "name": "delete-old", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "1d" } }
]
EOF
gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy \
  --location $REGION --policy /tmp/cleanup.json --no-dry-run
```

### 7. Cloud Scheduler（一次）

```bash
gcloud scheduler jobs create http health-tick --location $REGION \
  --schedule "*/5 * * * *" --time-zone "Asia/Taipei" \
  --uri "$SERVICE_URL/jobs/tick" --http-method POST \
  --oidc-service-account-email $SA_INVOKER --oidc-token-audience "$SERVICE_URL" \
  --attempt-deadline 300s
```

- 每 5 分鐘檢查一次，提醒最多延遲 5 分鐘。
- 只想在 07:00–22:59 執行（每天少約三分之一次數），把 `--schedule` 改成 `"*/5 7-22 * * *"`；之後要改用 `gcloud scheduler jobs update http health-tick --location $REGION --schedule "..."`。注意：提醒時間若設在這段時間以外就不會送出。

手動觸發一次確認：

```bash
gcloud scheduler jobs run health-tick --location $REGION
gcloud run services logs read health --region $REGION --limit 20
```

### 8. Firebase Hosting（第一次與每次更新 dashboard 都用這個）

```bash
firebase deploy --only hosting --project $PROJECT
```

完成後開啟 `https://<專案ID>.web.app`，用白名單內的 Google 帳號登入。`/api/**` 和 `/webhook` 會由 Hosting 轉送到 Cloud Run。

### 9. LINE 設定

1. **LINE Developers** → 你的 Messaging API Channel → Messaging API 分頁：
   - Webhook URL 填 **`$SERVICE_URL/webhook`**（Cloud Run 網址，例如 `https://health-123456789.asia-east1.run.app/webhook`）→ **Verify** 應顯示 Success。
     > 也可以填 `https://<專案ID>.web.app/webhook`（經 Hosting 轉送），但直接填 Cloud Run 網址少一層轉送。
   - 開啟 **Use webhook**；建議開啟 **Webhook redelivery**（佇列故障時 LINE 會重送，程式會自動去除重複）。
2. **LINE Official Account Manager** → 回應設定：關閉「自動回應訊息」。
3. 重新上傳圖文選單（讓「設定管理」按鈕連到新的 Dashboard 網址）：
   ```bash
   BASE_URL=https://$PROJECT.web.app node --env-file=.env scripts/setup-rich-menu.js
   ```

完成！之後 LINE Bot 不再需要本機電腦。

---

## 四、日常維護

| 要做的事 | 指令 |
|---|---|
| 更新後端程式 | 第 0 步設定變數 → 第 5 步 |
| 更新 Dashboard 網頁 | `firebase deploy --only hosting --project $PROJECT` |
| 看後端紀錄 | `gcloud run services logs read health --region $REGION --limit 50` |
| 看佇列狀態 | `gcloud tasks queues describe line-events --location $REGION` |
| 暫停所有排程 | `gcloud scheduler jobs pause health-tick --location $REGION`（恢復用 `resume`） |
| 新增允許登入的帳號 | 改 `.env` 的 `ALLOWED_EMAILS` → 第 5 步重新部署 |

## 五、費用注意事項

以個人使用量，以下服務預期都在免費額度內（實際以 Cloud Billing 帳單為準）：

- **Cloud Run**（依請求計費）：每 5 分鐘一次排程加上 LINE 訊息處理，遠低於每月 18 萬 vCPU 秒的免費額度。
- **Cloud Tasks**、**Cloud Scheduler**（每個帳單帳戶 3 個工作免費）、**Firebase Hosting / Authentication**：免費額度內。
- **Secret Manager**：6 個金鑰版本免費（與同帳單帳戶的其他專案共用），超過約每月每個 US$0.06。
- **Artifact Registry**：0.5 GB 免費，已用第 6 步自動清理。
- **Gemini API**：金鑰建在沒有帳單的專案才會走免費方案。

**會讓費用暴增的設定，請不要使用**：`--no-cpu-throttling`、`--min-instances 1` 以上、把 Cloud Scheduler 改成每分鐘執行。

## 六、本機開發

```bash
npm install
npm test
STORAGE=memory SEED_DEMO=1 DEV_AUTH_USER_ID=U_demo npm run dev   # http://localhost:8080，略過登入
```

本機未設定 `TASKS_QUEUE` 時，LINE 事件直接在程式內處理；`DEV_AUTH_USER_ID` 在 `NODE_ENV=production` 時無效。

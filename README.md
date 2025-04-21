# AI 論文陪讀助理 (AI Paper Reading Assistant)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

這是一個使用 Flask 和 OpenAI API 构建的 AI 論文陪讀 Web 應用程式，旨在協助使用者閱讀、理解和互動 PDF 格式的學術論文。

## ✨ 主要功能

* **PDF 上傳與顯示**: 使用者可以上傳本地 PDF 論文檔案，並在網頁上直接渲染閱讀 (使用 PDF.js)。
* **文件選擇**: 管理已上傳的文件，並可選擇特定文件進行深入對話。
* **上下文感知聊天 (當前頁面)**: 與 AI 進行對話時，AI 會自動獲取當前正在閱讀的 PDF 頁面內容作為上下文，讓提問更聚焦。
* **RAG 檢索增強生成**:
    * 在上傳 PDF 後，後端使用 LangChain 和 ChromaDB 進行處理，建立向量索引。
    * 與選定論文對話時，系統會檢索相關的文本片段，結合當前頁面內容，提供更精確、基於原文的回答。
* **通用聊天**: 在未選擇特定論文時，可以與 AI 模型進行通用知識問答。
* **文字選取**: 可在 PDF 閱讀器中選取文字。
* **即時翻譯 (提示框模式)**: 啟用「即時翻譯」選項後，選取的文字（目前預設從英文翻譯至繁體中文）會立即觸發翻譯，結果顯示在選取位置上方的提示框中。
* **手動翻譯 (聊天室模式)**: 未啟用即時翻譯時，選取文字後可點擊按鈕，將原文和翻譯結果發送到主聊天視窗。
* **頁面內容分析**: 點擊按鈕，AI (GPT-4.1 Vision) 會分析當前顯示的 PDF 頁面圖像（包含文字、圖表、表格等），並將摘要與解釋發送到主聊天視窗。
* **語音對話**:
    * 啟用「語音對話」選項。
    * **語音輸入 (STT)**: 透過點擊「開始錄音」按鈕（或之前的按住說話模式），使用 OpenAI Whisper API 將使用者的語音轉換為文字，並自動發送到聊天。包含簡易的**靜音偵測 (VAD)**，可在偵測到約 1.5 秒靜音後自動停止錄音並傳送。
    * **語音輸出 (TTS)**: 當語音模式啟用時，AI 的文字回覆會使用 OpenAI TTS API 合成語音並自動播放。文字訊息會**先於**語音顯示在聊天室中。
* **Markdown 支援**: 聊天室中來自 AI 的回覆（聊天、翻譯、分析）支援 Markdown 格式渲染，提高可讀性（如列表、粗體、程式碼區塊等）。
* **資料清除**: 提供按鈕（含確認步驟）以清除所有已上傳的 PDF 檔案、臨時音訊檔以及 ChromaDB 中的 RAG 索引資料。

## 🛠️ 技術棧

* **後端**: Python 3, Flask
* **前端**: HTML, CSS (Tailwind CSS via Play CDN), JavaScript
* **AI 模型**: OpenAI API
    * LLM & Vision: GPT-4.1 (或您 API 金鑰支援的其他 GPT-4 系列模型)
    * Embeddings: text-embedding-ada-002 (或更新模型)
    * STT: Whisper (whisper-1)
    * TTS: TTS-1 (alloy voice)
* **RAG**:
    * 框架: LangChain
    * 向量資料庫: ChromaDB (本地持久化)
* **PDF 處理**:
    * 後端: PyMuPDF (`import fitz`, via LangChain loader)
    * 前端: PDF.js (via CDN)
* **Markdown 渲染**: Marked.js (via CDN)
* **HTML 清理**: DOMPurify (via CDN)
* **環境管理**: python-dotenv

## 🚀 設定與安裝

1.  **複製儲存庫**:
    ```bash
    git clone [https://github.com/您的使用者名稱/您的儲存庫名稱.git](https://github.com/您的使用者名稱/您的儲存庫名稱.git)
    cd 您的儲存庫名稱
    ```

2.  **建立並啟用 Python 虛擬環境** (建議):
    ```bash
    # Windows
    python -m venv venv
    .\venv\Scripts\activate

    # macOS / Linux
    python3 -m venv venv
    source venv/bin/activate
    ```
    *之後的操作請確保虛擬環境是啟用的 (命令列提示符前有 `(venv)`)*

3.  **安裝 Python 依賴**:
    ```bash
    pip install -r requirements.txt
    ```
    *這會安裝 Flask, OpenAI, LangChain, ChromaDB, PyMuPDF 等所有必要的 Python 套件。*

4.  **設定 OpenAI API 金鑰**:
    * 複製或建立一個名為 `.env` 的檔案在專案根目錄下。
    * 在 `.env` 文件中加入您的 OpenAI API 金鑰：
        ```dotenv
        OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
        ALLOW_RESET=TRUE
        ```
    * **重要**: `ALLOW_RESET=TRUE` 是為了讓「清除所有資料」功能能夠重設 ChromaDB。**請勿** 將 `.env` 文件提交到 Git。

5.  **建立必要資料夾** (如果 `app.py` 啟動時因權限問題無法自動建立):
    * 手動在專案根目錄下建立 `uploads` 和 `temp_audio` 資料夾。`chroma_db` 資料夾通常會在第一次儲存向量時自動建立。

6.  **前端庫**:
    * PDF.js, Marked.js, DOMPurify, Tailwind CSS 均透過 CDN 載入，無需額外安裝步驟。

## ▶️ 運行應用程式

1.  **確保虛擬環境已啟用**。
2.  **運行 Flask 開發伺服器**:
    ```bash
    python app.py
    ```
3.  **開啟瀏覽器**並訪問： `http://127.0.0.1:5000` (或 Flask 顯示的其他地址)。

## 📖 使用說明

1.  **上傳 PDF**: 點擊「上傳論文」按鈕選擇 PDF 文件。上傳後會自動進行 RAG 處理。
2.  **選擇論文**: 在下拉選單中選擇您想對話的論文。選擇後，聊天將基於該論文內容（結合頁面上下文和 RAG）。選擇「-- 與通用模型對話 --」則進行不基於特定論文的通用聊天。
3.  **聊天**: 在底部的輸入框輸入問題，按 Enter 或點擊發送按鈕。
4.  **頁面上下文聊天**: 當選擇了特定論文後，AI 的回答會優先考慮您當前正在 PDF 檢視器中查看的頁面內容。
5.  **翻譯**:
    * **即時翻譯**: 勾選「啟用即時翻譯」，然後在 PDF 上選取文字，翻譯結果會出現在選取處上方的提示框中。
    * **手動翻譯**: 不勾選「啟用即時翻譯」，在 PDF 上選取文字，然後點擊「翻譯選取文字 (至聊天室)」按鈕，原文和翻譯結果會發送到聊天視窗。
6.  **頁面分析**: 導航到您想分析的 PDF 頁面，點擊「分析當前頁面 (至聊天室)」按鈕，分析結果會發送到聊天視窗。
7.  **語音對話**:
    * 勾選「啟用語音對話」，允許瀏覽器使用麥克風。
    * 點擊「開始錄音」按鈕開始說話。
    * 說完後，保持安靜約 1.5 秒，錄音會自動結束並處理；或者再次點擊按鈕手動結束。
    * 辨識出的文字會自動發送給 AI。
    * AI 的文字回覆會先顯示在聊天室，然後自動播放語音。
    * 取消勾選則停用語音功能。
8.  **清除資料**: 點擊側邊欄底部的「清除所有資料」按鈕，並在彈出的確認框中確認，即可刪除所有上傳的 PDF 和 RAG 數據。

## ⚙️ 設定

* **API 金鑰**: 主要設定在 `.env` 檔案中的 `OPENAI_API_KEY`。
* **模型名稱**: 可以在 `app.py` 頂部的 `LLM_MODEL_NAME` 和 `VISION_MODEL_NAME` 變數修改所使用的 OpenAI 模型（需要確保您的 API 金鑰有權限使用所選模型）。
* **ChromaDB 重設**: `.env` 檔案中的 `ALLOW_RESET=TRUE` 控制是否允許 `/clear_data` 路由重設資料庫。

## 🚀 未來改進方向

* **更可靠的 VAD**: 使用專門的 JavaScript VAD 庫（如 Silero VAD onnx）替代簡易的音量檢測。
* **使用者驗證**: 加入登入系統，讓不同使用者管理自己的論文。
* **背景任務**: 將 RAG 處理移至後台任務執行 (如 Celery)，避免長時間阻塞上傳請求。
* **上下文管理**: 對於非常長的對話或文件，實作更智能的上下文窗口管理或摘要機制。
* **錯誤處理**: 增強前端和後端的錯誤處理及使用者提示。
* **UI/UX 優化**:
    * 更精美的 Markdown 樣式。
    * 更清晰的加載/處理狀態指示器。
    * 可能需要將 Tailwind Play CDN 替換為 Build Process 以獲得更佳性能和自訂性。
* **部署**: 添加生產環境部署指南 (例如使用 Gunicorn/Waitress + Nginx)。
* **測試**: 加入單元測試和整合測試。

## 📄 授權 (License)

本專案採用 **Apache License 2.0** 授權。詳情請見 [LICENSE](LICENSE) 文件或訪問 [http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)。
// --- Global Variables ---
let currentPdfDoc = null;
let currentPageNum = 1;
let pageRendering = false;
let currentPdfScale = 1.5;
let selectedText = ''; // Stores text for manual translate button

// --- Wait for the DOM to be fully loaded ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded. Initializing main.js...");

    // --- DOM Element References (Obtain AFTER DOM is ready) ---
    const pdfViewerContainer = document.getElementById('pdf-viewer-container');
    const textLayerDiv = document.getElementById('text-layer');
    const pdfLoader = document.getElementById('pdf-loader');
    const uploadInput = document.getElementById('pdf-upload');
    const uploadStatus = document.getElementById('upload-status');
    const paperSelect = document.getElementById('paper-select');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendChatBtn = document.getElementById('send-chat-btn');
    const prevPageBtn = document.getElementById('prev-page');
    const nextPageBtn = document.getElementById('next-page');
    const pageNumInput = document.getElementById('page-num-input');
    const pageCountSpan = document.getElementById('page-count');
    const selectedTextDisplay = document.getElementById('selected-text-display');
    const translateBtn = document.getElementById('translate-btn');
    const instantTranslateToggle = document.getElementById('instant-translate-toggle');
    const translationTooltip = document.getElementById('translation-tooltip');
    const analyzePageBtn = document.getElementById('analyze-page-btn');
    const voiceToggle = document.getElementById('voice-toggle');
    const clearDataBtn = document.getElementById('clear-data-btn');
    const pageContextToggle = document.getElementById('page-context-toggle'); // Context Toggle Ref

    // --- Canvas Elements (created dynamically) ---
    let pdfCanvas = null;
    let pdfCtx = null;

    // --- Initial Element Verification ---
    const essentialIds = [
        'pdf-viewer-container', 'text-layer', 'pdf-loader', 'pdf-upload',
        'upload-status', 'paper-select', 'chat-messages', 'chat-input',
        'send-chat-btn', 'prev-page', 'next-page', 'page-num-input',
        'page-count', 'selected-text-display', 'translate-btn',
        'instant-translate-toggle', 'translation-tooltip', 'analyze-page-btn', 'voice-toggle',
        'clear-data-btn', 'page-context-toggle'
    ];
    let missingElement = false;
    essentialIds.forEach(id => {
        const element = document.getElementById(id);
        if (!element) {
            console.error(`CRITICAL: Element with ID '${id}' not found! Check HTML.`);
            missingElement = true;
        }
    });
    if (missingElement) {
        alert("頁面初始化錯誤，部分介面元素遺失，功能可能不完整。");
    } else {
         console.log("All essential DOM elements verified.");
    }

    // --- Canvas Initialization ---
    function initializeCanvas() {
        console.log("Attempting to initialize canvas...");
        if (!pdfViewerContainer || !textLayerDiv) { console.error("Cannot initialize canvas: Parent or text layer missing."); return false; }
        const existingCanvas = document.getElementById('pdf-canvas');
        if (existingCanvas) { existingCanvas.remove(); console.log("Removed existing canvas."); }
        pdfCanvas = document.createElement('canvas'); pdfCanvas.id = 'pdf-canvas';
        pdfCanvas.style.position = 'absolute'; pdfCanvas.style.top = '0'; pdfCanvas.style.left = '0';
        pdfCanvas.style.display = 'block'; pdfCanvas.style.margin = '0 auto'; pdfCanvas.style.pointerEvents = 'none';
        pdfViewerContainer.insertBefore(pdfCanvas, textLayerDiv); pdfCtx = pdfCanvas.getContext('2d');
        if (pdfCanvas && pdfCtx) { console.log("Canvas initialized successfully."); return true; }
        else { console.error("Failed to create canvas or get 2D context."); return false; }
    }

    // --- PDF Handling Functions ---
    async function loadPdf(url) {
        if (typeof pdfjsLib === 'undefined' || !pdfjsLib.getDocument) { console.error("pdfjsLib not ready!"); setUploadStatus("PDF 庫初始化錯誤。", "error"); return; }
        showLoader(true, "正在加載 PDF...");
        try {
            if (currentPdfDoc) { await currentPdfDoc.destroy(); currentPdfDoc = null; }
            if (!initializeCanvas()) { throw new Error("Canvas 初始化失敗。"); }
            const loadingTask = pdfjsLib.getDocument(url);
            currentPdfDoc = await loadingTask.promise;
            console.log('PDF loaded:', url); setUploadStatus("PDF 加載完成。", "success");
            const numPages = currentPdfDoc.numPages; if(pageCountSpan) pageCountSpan.textContent = numPages; if(pageNumInput) pageNumInput.max = numPages; currentPageNum = 1;
            await renderPage(currentPageNum);
            updatePaginationControls(); if(analyzePageBtn) analyzePageBtn.disabled = false;
        } catch (reason) { console.error('Error loading PDF: ', reason); setUploadStatus(`加載 PDF 失敗: ${reason.message || reason}`, "error"); currentPdfDoc = null; clearPdfDisplay(); updatePaginationControls(); if(analyzePageBtn) analyzePageBtn.disabled = true; }
        finally { showLoader(false); }
    }

    async function renderPage(num) {
        if (!currentPdfDoc || pageRendering) { console.warn(`Rendering page ${num} skipped.`); return; }
        if (!pdfCanvas || !pdfCtx) { console.error(`Cannot render page ${num}: Canvas/Context missing.`); if (!initializeCanvas()) { setUploadStatus("Canvas 錯誤。", "error"); return; } console.log("Canvas re-initialized."); }
        pageRendering = true; showLoader(true, `渲染第 ${num} 頁...`); if(pageNumInput) pageNumInput.value = num;
        try {
            hideTranslationTooltip();
            const page = await currentPdfDoc.getPage(num); const viewport = page.getViewport({ scale: currentPdfScale });
            pdfCanvas.height = viewport.height; pdfCanvas.width = viewport.width; pdfCanvas.style.height = `${viewport.height}px`; pdfCanvas.style.width = `${viewport.width}px`;
            pdfCanvas.style.position = 'absolute'; pdfCanvas.style.top = '0'; pdfCanvas.style.left = '0'; pdfCanvas.style.pointerEvents = 'none';
            if (!textLayerDiv) { throw new Error("Text layer container not found!"); }
            while (textLayerDiv.firstChild) { textLayerDiv.removeChild(textLayerDiv.firstChild); }
            textLayerDiv.style.width = `${viewport.width}px`; textLayerDiv.style.height = `${viewport.height}px`;
            textLayerDiv.style.position = 'absolute'; textLayerDiv.style.top = '0'; textLayerDiv.style.left = '0';
            textLayerDiv.style.setProperty('--scale-factor', viewport.scale); console.log(`Set --scale-factor to ${viewport.scale}`);
            const renderContext = { canvasContext: pdfCtx, viewport: viewport }; const renderCanvasTask = page.render(renderContext).promise; const getTextContentTask = page.getTextContent();
            const [ , textContent] = await Promise.all([renderCanvasTask, getTextContentTask]);
            console.log(`Page ${num} canvas rendered.`); console.log(`Text content loaded.`);
            if (textLayerDiv) { await pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport: viewport, enhanceTextSelection: true, }).promise.catch(err => console.error(`Error rendering text layer: ${err}`)); console.log(`Text layer rendered for page ${num}.`); }
        } catch (error) { console.error(`Error rendering page ${num}:`, error); setUploadStatus(`渲染頁面 ${num} 出錯: ${error.message || error}`, "error"); }
        finally { pageRendering = false; showLoader(false); }
    }

    // --- Utility Functions ---
    function showLoader(show, message = '') { if (!pdfLoader) return; pdfLoader.classList.toggle('hidden', !show); if (show && message) { setUploadStatus(message, "loading"); } }
    function setUploadStatus(message, type = "info") { if (!uploadStatus) return; uploadStatus.textContent = message; uploadStatus.className = 'mt-2 text-xs min-h-[1.2em]'; switch (type) { case "success": uploadStatus.classList.add('text-green-600', 'dark:text-green-400'); break; case "error": uploadStatus.classList.add('text-red-600', 'dark:text-red-400'); break; case "loading": uploadStatus.classList.add('text-yellow-600', 'dark:text-yellow-400'); break; default: uploadStatus.classList.add('text-gray-600', 'dark:text-gray-400'); } }
    function clearPdfDisplay() { if (pdfCanvas && pdfCtx) { pdfCtx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height); pdfCanvas.width = 0; pdfCanvas.height = 0; pdfCanvas.style.width = '0px'; pdfCanvas.style.height = '0px'; } if (textLayerDiv) { while (textLayerDiv.firstChild) { textLayerDiv.removeChild(textLayerDiv.firstChild); } textLayerDiv.style.width = '0px'; textLayerDiv.style.height = '0px'; } if(pageCountSpan) pageCountSpan.textContent = 0; if(pageNumInput) { pageNumInput.value = 0; pageNumInput.max = 1; } currentPdfDoc = null; currentPageNum = 1; updatePaginationControls(); if(analyzePageBtn) analyzePageBtn.disabled = true; console.log("PDF display cleared."); }
    function updatePaginationControls() { const enabled = !!currentPdfDoc; const numPages = currentPdfDoc?.numPages ?? 0; if(prevPageBtn) prevPageBtn.disabled = !enabled || currentPageNum <= 1; if(nextPageBtn) nextPageBtn.disabled = !enabled || currentPageNum >= numPages; if(pageNumInput) pageNumInput.disabled = !enabled; if(enabled && pageNumInput) { pageNumInput.value = currentPageNum; pageNumInput.max = numPages;} else if (pageNumInput) { pageNumInput.value = 0; pageNumInput.max = 1; } }
    function goToPage(num) { if (!currentPdfDoc || isNaN(num) || num < 1 || num > currentPdfDoc.numPages) { if(pageNumInput) pageNumInput.value = currentPageNum; console.warn(`Invalid page: ${num}`); return; } if (num === currentPageNum || pageRendering) { if(pageNumInput) pageNumInput.value = currentPageNum; return; } currentPageNum = num; /* UPDATE GLOBAL */ renderPage(currentPageNum); updatePaginationControls(); }
    async function loadPaperList() { if (!paperSelect) { console.error("Paper select dropdown not found."); return; } console.log("Loading paper list..."); try { const response = await fetch('/papers'); if (!response.ok) { console.error('Failed list fetch:', response.status); return; } const papers = await response.json(); console.log("Papers received for dropdown:", papers); /* Log fetched data */ const currentSelectedValue = paperSelect.value; paperSelect.options.length = 1; if (papers && Array.isArray(papers) && papers.length > 0) { papers.forEach(paper => { const option = document.createElement('option'); option.value = paper.paper_id; const displayName = paper.display_name || `Paper ${paper.paper_id.substring(0, 8)}`; option.textContent = displayName.length > 50 ? displayName.substring(0, 47) + '...' : displayName; option.title = displayName; paperSelect.appendChild(option); }); console.log("Paper list populated."); const exists = papers.some(p => p.paper_id === currentSelectedValue); if (exists) { paperSelect.value = currentSelectedValue; } else { paperSelect.value = ""; } } else { console.log("No papers found."); paperSelect.value = ""; } } catch (error) { console.error('Error loading paper list:', error); } }

    /** Adds a message to the chat display area, rendering Markdown. */
    function addChatMessage(sender, message, type = 'normal', clearPrevious = false) {
        if (!chatMessages) { console.error("Chat message area not found."); return; }
        if(clearPrevious) { chatMessages.innerHTML = '<div class="initial-chat-prompt text-gray-500 dark:text-gray-400 italic text-sm p-2 text-center">請先上傳或選擇一篇論文...</div>'; }
        const messageElement = document.createElement('div');
        messageElement.classList.add('p-2', 'mb-2', 'rounded-lg', 'max-w-xl', 'chat-bubble', 'text-sm', 'break-words');
        const initialPrompt = chatMessages.querySelector('.initial-chat-prompt');
        if (initialPrompt && (sender === 'user' || sender === 'bot' || sender === 'analysis' || sender === 'translation')) { initialPrompt.remove(); }
        let requiresMarkdown = false;
        switch (sender) {
            case 'user': messageElement.classList.add('user-bubble', 'ml-auto'); break;
            case 'bot': messageElement.classList.add('bot-bubble', 'mr-auto', 'markdown-content'); requiresMarkdown = true; break;
            case 'analysis': messageElement.classList.add('analysis-bubble', 'mr-auto', 'markdown-content'); requiresMarkdown = true; break;
            case 'translation': messageElement.classList.add('translation-bubble', 'mr-auto', 'markdown-content'); requiresMarkdown = true; break;
            case 'system': messageElement.classList.add('text-xs', 'text-center', 'text-gray-500', 'dark:text-gray-400', 'italic', 'my-2', 'w-full', 'max-w-full'); break;
            default: messageElement.classList.add('bot-bubble', 'opacity-80', 'mr-auto'); break;
        }
        if (type === 'error') { messageElement.classList.add('bg-red-100', 'dark:bg-red-800', 'text-red-800', 'dark:text-red-100', 'border', 'border-red-300', 'dark:border-red-600'); }
        if (requiresMarkdown && typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') { try { messageElement.innerHTML = DOMPurify.sanitize(marked.parse(message)); } catch (e) { console.error("Markdown/Sanitize error:", e); messageElement.textContent = message; } }
        else { if (requiresMarkdown) console.warn("Markdown/Sanitizer missing for sender:", sender); messageElement.textContent = message; }
        chatMessages.appendChild(messageElement); chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    // Expose addChatMessage globally AFTER it's defined
    window.addChatMessage = addChatMessage;

    /** Sends chat message, handles response & potential TTS call */
    async function sendChatMessage() {
        if (!chatInput || !sendChatBtn) return; const message = chatInput.value.trim(); if (!message) return;
        const selectedPaperId = paperSelect ? paperSelect.value : null;
        // Determine context mode based on checkbox state
        const useContextMode = pageContextToggle && pageContextToggle.checked ? 'page' : 'document';
        const payload = { message: message, paper_id: selectedPaperId || null, currentPageNum: currentPageNum, context_mode: useContextMode };
        addChatMessage('user', message); chatInput.value = ''; chatInput.disabled = true; sendChatBtn.disabled = true;
        sendChatBtn.innerHTML = `<svg class="animate-spin h-5 w-5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
        try {
            // *** Log the exact payload being sent ***
            console.log("Sending to /chat with payload:", JSON.stringify(payload, null, 2)); // Pretty print JSON
            const response = await fetch('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!response.ok) { let e = `HTTP ${response.status}`; try { const d = await response.json(); e = d.error||e; } catch(ig){} throw new Error(e); }
            const result = await response.json(); const botReply = result.reply || "收到空回覆";
            // Display text first
            addChatMessage('bot', botReply);
            // Then play voice if enabled
            const isVoiceEnabled = voiceToggle ? voiceToggle.checked : false;
            if (isVoiceEnabled && typeof window.playVoiceResponse === 'function') { console.log("Voice mode on, calling playVoiceResponse..."); window.playVoiceResponse(botReply); }
            else { console.log("Voice mode off or playVoiceResponse unavailable."); }
        } catch (error) { console.error('Chat error:', error); addChatMessage('system', `請求錯誤: ${error.message || error}`, 'error');
        } finally { chatInput.disabled = false; sendChatBtn.disabled = false; sendChatBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>`; if(chatInput) chatInput.focus(); }
    }
    // Expose sendChatMessage globally AFTER it's defined
    window.sendChatMessage = sendChatMessage;


    // --- Text Selection & Translation ---
    function hideTranslationTooltip() { if (translationTooltip) { translationTooltip.style.display = 'none'; translationTooltip.textContent = ''; console.log("Tooltip hidden."); } }
    async function showTranslationTooltip(textToTranslate, selectionRange) { if (!translationTooltip) { console.error("Tooltip element not found."); return; } if (!textToTranslate || !selectionRange) { console.warn("showTooltip missing text/range."); return; } console.log("Attempting show tooltip for:", textToTranslate); translationTooltip.textContent = '翻譯中...'; translationTooltip.style.removeProperty('transform'); translationTooltip.style.removeProperty('top'); translationTooltip.style.removeProperty('left'); try { const rect = selectionRange.getBoundingClientRect(); const containerRect = pdfViewerContainer.getBoundingClientRect(); const scrollTop = pdfViewerContainer.scrollTop; const scrollLeft = pdfViewerContainer.scrollLeft; console.log("Sel Rect:", JSON.stringify(rect)); console.log("Cont Rect:", JSON.stringify(containerRect)); console.log("Scroll T/L:", scrollTop, scrollLeft); if (!rect || rect.width === 0 || rect.height === 0) { console.warn("Selection rect invalid."); hideTranslationTooltip(); return; } let top = (rect.top - containerRect.top + scrollTop) - 30; let left = (rect.left - containerRect.left + scrollLeft) + (rect.width / 2); translationTooltip.style.left = `${left}px`; translationTooltip.style.top = `${top}px`; translationTooltip.style.transform = 'translateX(-50%)'; translationTooltip.style.display = 'block'; console.log(`Tooltip shown. Init T/L: ${top}px/${left}px`); requestAnimationFrame(async () => { try { const tooltipHeight = translationTooltip.offsetHeight; top = (rect.top - containerRect.top + scrollTop) - tooltipHeight - 5; top = Math.max(scrollTop, top); translationTooltip.style.top = `${top}px`; console.log(`Tooltip H/T: ${tooltipHeight}px/${top}px`); console.log("Requesting instant translation:", textToTranslate); const response = await fetch('/translate', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ text: textToTranslate }) }); if (!response.ok) { let e=`HTTP ${response.status}`; try{const d=await response.json();e=d.error||e;}catch(ig){} throw new Error(e); } const result = await response.json(); if (result.translation) { translationTooltip.textContent = result.translation; console.log("Instant translation received:", result.translation); requestAnimationFrame(() => { const h=translationTooltip.offsetHeight; let fT=(rect.top-containerRect.top+scrollTop)-h-5; fT=Math.max(scrollTop, fT); translationTooltip.style.top=`${fT}px`; console.log(`Tooltip final H/T: ${h}px/${fT}px`); }); } else { translationTooltip.textContent = "翻譯結果為空"; } } catch (error) { console.error("Instant translation fetch/pos failed:", error); translationTooltip.textContent = `翻譯失敗: ${error.message || '錯誤'}`; } }); } catch (e) { console.error("Error calculating tooltip pos:", e); hideTranslationTooltip(); } }
    function handleTextSelection(event) { if (translationTooltip && translationTooltip.contains(event.target)) { console.log("Selection ignored: Target is tooltip."); return; } const currentSelection = window.getSelection(); console.log("--- Selection Event Start ---"); if (!currentSelection || currentSelection.isCollapsed) { console.log("Selection collapsed."); if (translationTooltip && translationTooltip.style.display !== 'none') { hideTranslationTooltip(); } console.log("--- Selection Event End (Empty) ---"); return; } const rawSelectedText = currentSelection.toString(); const trimmedSelectedText = rawSelectedText.trim(); const instantTranslateEnabled = instantTranslateToggle ? instantTranslateToggle.checked : false; console.log(`Instant Mode: ${instantTranslateEnabled}`); console.log(`Raw: "${rawSelectedText}"`); console.log(`Trimmed: "${trimmedSelectedText}"`); if (trimmedSelectedText && trimmedSelectedText.length >= 1) { let selectionRange = null; try { if (currentSelection.rangeCount > 0) { selectionRange = currentSelection.getRangeAt(0); console.log("Range obtained."); } else { console.warn("No range."); } } catch (e) { console.error("Error getting range:", e); } if (instantTranslateEnabled) { console.log("Entering Instant Translate branch."); if (selectionRange) { hideTranslationTooltip(); showTranslationTooltip(trimmedSelectedText, selectionRange); } else { console.error("Cannot show tooltip: invalid range."); hideTranslationTooltip(); } if(selectedTextDisplay) selectedTextDisplay.textContent = '(即時翻譯已啟用)'; if(translateBtn) translateBtn.disabled = true; selectedText = ''; } else { console.log("Entering Manual Translate branch."); selectedText = trimmedSelectedText; const previewText = selectedText.length > 100 ? selectedText.substring(0, 97) + '...' : selectedText; if (!selectedTextDisplay) { console.error("#selected-text-display not found!"); return; } selectedTextDisplay.textContent = `選中: ${previewText}`; selectedTextDisplay.title = selectedText; if(translateBtn) translateBtn.disabled = false; hideTranslationTooltip(); console.log("Sidebar updated for manual."); } } else { console.log("Selection condition not met."); hideTranslationTooltip(); if (!instantTranslateEnabled && selectedTextDisplay && translateBtn) { selectedTextDisplay.textContent = '請在 PDF 中選取文字...'; translateBtn.disabled = true; selectedText = ''; } } console.log("--- Selection Event End ---"); }

    // --- Event Listeners Setup ---
    if(prevPageBtn) prevPageBtn.addEventListener('click', () => { if (currentPageNum > 1) goToPage(currentPageNum - 1); });
    if(nextPageBtn) nextPageBtn.addEventListener('click', () => { if (currentPdfDoc && currentPageNum < currentPdfDoc.numPages) goToPage(currentPageNum + 1); });
    if(pageNumInput) { pageNumInput.addEventListener('change', () => { goToPage(parseInt(pageNumInput.value, 10)); }); pageNumInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') pageNumInput.blur(); }); }
    if(uploadInput) uploadInput.addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file || file.type !== 'application/pdf') { setUploadStatus('請選擇一個有效的 PDF 文件。', "error"); uploadInput.value = ''; return; } clearPdfDisplay(); updatePaginationControls(); if(analyzePageBtn) analyzePageBtn.disabled = true; if(selectedTextDisplay) selectedTextDisplay.textContent = '請在 PDF 中選取文字...'; if(translateBtn) translateBtn.disabled = true; hideTranslationTooltip(); setUploadStatus('', 'info'); showLoader(true, "正在上傳並處理..."); const formData = new FormData(); formData.append('pdf_file', file); try { const response = await fetch('/upload', { method: 'POST', body: formData }); const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP error! status: ${response.status}`); console.log("Uploaded File Info:", result); await loadPdf(result.filepath); console.log("Upload successful, refreshing paper list..."); await loadPaperList(); /* Refresh dropdown */ if (result.paper_id && paperSelect) { paperSelect.value = result.paper_id; console.log(`Selected paper automatically: ${result.paper_id}`); const selectedOption = paperSelect.options[paperSelect.selectedIndex]; const selectedName = selectedOption.title || selectedOption.textContent || "新文件"; addChatMessage('system', `已自動選擇: ${selectedName}`); } } catch (error) { console.error('Upload or Processing error:', error); setUploadStatus(`上傳或處理失敗: ${error.message || error}`, "error"); showLoader(false); } finally { uploadInput.value = ''; } });
    if(paperSelect) paperSelect.addEventListener('change', () => { const selectedOption = paperSelect.options[paperSelect.selectedIndex]; const selectedName = selectedOption.title || selectedOption.textContent || "通用模型"; const selectedId = paperSelect.value; addChatMessage('system', `對話目標已切換至: ${selectedName}`); console.log(`Selected paper ID: ${selectedId || 'None (General Chat)'}`); hideTranslationTooltip(); });
    if(sendChatBtn) sendChatBtn.addEventListener('click', sendChatMessage);
    if(chatInput) chatInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChatMessage(); } });
    if(pdfViewerContainer) { pdfViewerContainer.addEventListener('mouseup', handleTextSelection); pdfViewerContainer.addEventListener('touchend', handleTextSelection); }
    if(translateBtn) translateBtn.addEventListener('click', async () => { if (!selectedText || !translateBtn || translateBtn.disabled || (instantTranslateToggle && instantTranslateToggle.checked)) { console.log("Manual translate ignored."); return; } addChatMessage('system', `正在翻譯選取的文字:\n> ${selectedText.substring(0,100)}...`); translateBtn.disabled = true; if(selectedTextDisplay) selectedTextDisplay.textContent = `(正在翻譯...)`; try { const response = await fetch('/translate', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ text: selectedText }) }); if (!response.ok) { let e = `HTTP ${response.status}`; try { const d = await response.json(); e = d.error||e; } catch(ig){} throw new Error(e); } const result = await response.json(); const translationResultText = result.translation || "翻譯結果為空"; const originalTextFormatted = `> ${selectedText.replace(/\n/g, '\n> ')}`; const chatMessage = `**選取文字翻譯結果:**\n\n${originalTextFormatted}\n\n**翻譯:**\n${translationResultText}`; addChatMessage('translation', chatMessage, 'normal'); console.log("Manual translation added to chat."); if(selectedTextDisplay) selectedTextDisplay.textContent = '請在 PDF 中選取文字...'; selectedText = ''; } catch (error) { console.error("Manual translation request failed:", error); addChatMessage('system', `翻譯失敗: ${error.message || '未知錯誤'}`, 'error'); if(selectedTextDisplay) selectedTextDisplay.textContent = `翻譯失敗，請重試。`; } });
    if(instantTranslateToggle) instantTranslateToggle.addEventListener('change', () => { hideTranslationTooltip(); selectedText = ''; if(translateBtn) translateBtn.disabled = true; if (instantTranslateToggle.checked) { console.log("Instant translate ENABLED"); if(selectedTextDisplay) selectedTextDisplay.textContent = '(即時翻譯已啟用)'; } else { console.log("Instant translate DISABLED"); if(selectedTextDisplay) selectedTextDisplay.textContent = '請在 PDF 中選取文字...'; } });
    // analyzePageBtn listener is in analysis.js
    if(voiceToggle) voiceToggle.addEventListener('change', () => { /* Logic handled in voice.js */ });
    if(clearDataBtn) clearDataBtn.addEventListener('click', async () => { const confirmation = window.confirm("危險操作！\n\n您確定要清除所有已上傳的論文 PDF 檔案以及相關的 RAG 分析資料嗎？\n\n這個操作無法復原！"); if (confirmation) { console.log("User confirmed data clearing."); setUploadStatus("正在清除資料...", "loading"); clearDataBtn.disabled = true; const originalBtnHtml = clearDataBtn.innerHTML; clearDataBtn.innerHTML = `<svg class="animate-spin h-4 w-4 inline mr-1" ...></svg> 清除中...`; try { const response = await fetch('/clear_data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, }); const result = await response.json(); if (response.ok) { console.log("Data cleared successfully."); setUploadStatus(result.message || "資料已成功清除。", "success"); clearPdfDisplay(); if(paperSelect) paperSelect.options.length = 1; if(chatMessages) { chatMessages.innerHTML = '<div class="initial-chat-prompt ...">請先上傳...</div>'; } if(selectedTextDisplay) selectedTextDisplay.textContent = '請在 PDF 中選取文字...'; selectedText = ''; if(translateBtn) translateBtn.disabled = true; if(instantTranslateToggle) instantTranslateToggle.checked = false; hideTranslationTooltip(); if(analyzePageBtn) analyzePageBtn.disabled = true; await loadPaperList(); /* Refresh dropdown */ } else { console.error("Error clearing data:", result.error, result.details); setUploadStatus(`清除失敗: ${result.error || '未知錯誤'}`, "error"); } } catch (error) { console.error("Clear data request error:", error); setUploadStatus(`清除請求失敗: ${error.message || '網路錯誤'}`, "error"); } finally { clearDataBtn.disabled = false; clearDataBtn.innerHTML = originalBtnHtml; } } else { console.log("User cancelled data clearing."); } });
    document.addEventListener('click', (event) => { if (translationTooltip && translationTooltip.style.display !== 'none') { if (!translationTooltip.contains(event.target) && pdfViewerContainer && !pdfViewerContainer.contains(event.target)) { console.log("Clicked outside viewer/tooltip, hiding tooltip."); hideTranslationTooltip(); } } });

    // --- Initial Setup Calls ---
    loadPaperList();
    updatePaginationControls();
    if(analyzePageBtn) analyzePageBtn.disabled = true;
    if(translateBtn) translateBtn.disabled = true;

    console.log("main.js Initialization Complete inside DOMContentLoaded.");

}); // End of DOMContentLoaded listener

console.log("main.js script processed (before DOMContentLoaded event).");
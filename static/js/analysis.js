document.addEventListener('DOMContentLoaded', () => {

    console.log("Analysis script loaded and DOM ready.");

    // Get references AFTER DOM is ready
    const analyzePageBtn = document.getElementById('analyze-page-btn');

    // Verify elements exist
    if (!analyzePageBtn) {
        console.error("Analyze button (#analyze-page-btn) not found in analysis.js!");
        return; // Stop if button isn't found
    }

    analyzePageBtn.addEventListener('click', async () => {
        console.log("Analyze Page button clicked.");

        if (analyzePageBtn.disabled) { console.log("Analyze button is disabled."); return; }
        const pdfCanvas = document.getElementById('pdf-canvas'); // Get canvas dynamically
        if (!pdfCanvas || pdfCanvas.width === 0 || pdfCanvas.height === 0) {
            console.error("PDF Canvas not found or is empty for analysis.");
            // Use the globally exposed addChatMessage function (if available)
            if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', "錯誤：無法獲取 PDF 頁面圖像以進行分析。", 'error'); }
            else { alert("錯誤：無法獲取 PDF 頁面圖像以進行分析。"); }
            return;
        }
        // Access currentPageNum (ensure it's global or accessible from main.js)
        if (typeof currentPageNum === 'undefined') {
             console.error("currentPageNum is not accessible from main.js scope.");
             if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', "錯誤：無法獲取當前頁碼。", 'error'); }
             else { alert("錯誤：無法獲取當前頁碼。"); }
             return;
        }
        console.log(`Analyzing page number: ${currentPageNum}`);

        // --- Start Analysis Process ---
        if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', `正在分析第 ${currentPageNum} 頁...`); }
        analyzePageBtn.disabled = true;
        const originalButtonText = analyzePageBtn.innerHTML; // Store original html
        analyzePageBtn.innerHTML = `<svg class="animate-spin h-4 w-4 inline mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>分析中...`;

        try {
            // 1. Capture Canvas as Image
            const imageDataUrl = pdfCanvas.toDataURL('image/png');
            console.log(`Captured image data URL (length: ${imageDataUrl.length})`);
            if (!imageDataUrl || imageDataUrl === 'data:,') throw new Error("無法從畫布獲取圖像數據。");

            // 2. Send data to backend
            const response = await fetch('/analyze_page', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_data: imageDataUrl, page_num: currentPageNum })
            });

            // 3. Handle response
            if (!response.ok) { let e = `HTTP ${response.status}`; try { const d = await response.json(); e = d.error||e; } catch(ig){} throw new Error(e); }
            const result = await response.json();

            if (result.analysis) {
                const analysisMessage = `**第 ${currentPageNum} 頁分析結果:**\n\n${result.analysis}`;
                // Use globally exposed addChatMessage
                if (typeof window.addChatMessage === 'function') { window.addChatMessage('analysis', analysisMessage, 'normal'); }
                else { console.error("addChatMessage function not found."); alert(`分析結果:\n${result.analysis}`); }
                console.log("Analysis successful.");
            } else {
                if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', `AI 未能提供第 ${currentPageNum} 頁的分析結果。`, 'error'); }
                else { alert(`AI 未能提供第 ${currentPageNum} 頁的分析結果。`); }
                console.warn("Analysis response empty.");
            }
        } catch (error) {
            console.error("Page analysis failed:", error);
             if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', `分析失敗: ${error.message || '未知錯誤'}`, 'error'); }
             else { alert(`分析失敗: ${error.message || '未知錯誤'}`); }
        } finally {
            // Re-enable button only if a PDF is currently loaded (check global state)
             if (typeof currentPdfDoc !== 'undefined' && currentPdfDoc) {
                 analyzePageBtn.disabled = false;
             } else {
                 analyzePageBtn.disabled = true; // Keep disabled if no PDF
             }
            analyzePageBtn.innerHTML = originalButtonText; // Restore button text/icon
            console.log("Analysis process finished.");
        }
    });

}); // End of DOMContentLoaded listener
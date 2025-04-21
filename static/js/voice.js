document.addEventListener('DOMContentLoaded', () => {
    console.log("Voice script loaded and DOM ready.");

    // --- DOM Elements ---
    const voiceToggle = document.getElementById('voice-toggle');
    const recordBtn = document.getElementById('record-btn');
    const recordBtnText = document.getElementById('record-btn-text');
    const micStatus = document.getElementById('mic-status');
    const chatInput = document.getElementById('chat-input');

    // --- State Variables ---
    let isVoiceModeEnabled = false;
    let mediaRecorder = null;
    let audioChunks = [];
    let audioStream = null;
    let isRecording = false;
    let currentAudioPlayer = null;

    // --- VAD Variables ---
    let audioContext = null;
    let analyser = null;
    let microphoneSource = null;
    let silenceTimer = null;
    const SILENCE_THRESHOLD = 0.01; // May need adjustment
    const SILENCE_DELAY_MS = 1500;
    const VAD_CHECK_INTERVAL_MS = 200;

    // --- Check browser support and elements ---
    window.AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { console.error("getUserMedia unsupported!"); if (voiceToggle) voiceToggle.disabled = true; if (micStatus) micStatus.textContent = "錯誤：瀏覽器不支援麥克風。"; return; }
    if (!window.MediaRecorder) { console.error("MediaRecorder unsupported!"); if (voiceToggle) voiceToggle.disabled = true; if (micStatus) micStatus.textContent = "錯誤：瀏覽器不支援錄音。"; return; }
    if (!window.AudioContext) { console.error("AudioContext unsupported!"); if (voiceToggle) voiceToggle.disabled = true; if (micStatus) micStatus.textContent = "錯誤：音訊處理不支持。"; return; }
    if (!voiceToggle || !recordBtn || !recordBtnText || !micStatus || !chatInput) { console.error("Voice UI elements missing!"); if (voiceToggle) voiceToggle.disabled = true; return; }

    // --- Core Audio Functions ---
    function setupAudioContext() {
        try {
            if (!audioContext || audioContext.state === 'closed') { audioContext = new AudioContext(); console.log("AudioContext created/recreated."); }
            if (audioContext.state === 'suspended') { audioContext.resume().then(() => console.log("AudioContext resumed.")); }
            if (!analyser) { analyser = audioContext.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.8; console.log("AnalyserNode created."); }
            if (microphoneSource && audioStream) { try { microphoneSource.disconnect(); } catch(e){} microphoneSource = audioContext.createMediaStreamSource(audioStream); microphoneSource.connect(analyser); console.log("Mic source reconnected."); }
            else if (!microphoneSource && audioStream) { microphoneSource = audioContext.createMediaStreamSource(audioStream); microphoneSource.connect(analyser); console.log("Mic source connected."); }
            return true;
        } catch (err) { console.error("AudioContext/Analyser setup error:", err); if(micStatus) micStatus.textContent = "音訊分析器錯誤"; return false; }
    }

    function monitorVolume() {
        if (!isRecording || !analyser || !audioContext || audioContext.state !== 'running') { clearTimeout(silenceTimer); silenceTimer = null; return; }
        const bufferLength = analyser.frequencyBinCount; const dataArray = new Uint8Array(bufferLength);
        try { analyser.getByteTimeDomainData(dataArray); } catch (e) { console.error("VAD Error getting data", e); return; }
        let sumSquares = 0.0; for (const amp of dataArray) { const norm = (amp / 128.0) - 1.0; sumSquares += norm * norm; }
        const rms = Math.sqrt(sumSquares / bufferLength);
        if (rms > SILENCE_THRESHOLD) { clearTimeout(silenceTimer); silenceTimer = null; }
        else { if (!silenceTimer) { silenceTimer = setTimeout(() => { console.log(`Silence detected for ${SILENCE_DELAY_MS}ms.`); stopRecording(); silenceTimer = null; }, SILENCE_DELAY_MS); } }
        if(isRecording) requestAnimationFrame(monitorVolume); // Only continue if still recording
    }

    async function setupAudioRecorder() {
        try {
            if(micStatus) micStatus.textContent = "請求麥克風權限...";
            if (audioStream) { audioStream.getTracks().forEach(track => track.stop()); } // Stop previous stream first
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if(micStatus) micStatus.textContent = "權限已獲取，準備。"; if(recordBtn) recordBtn.disabled = false;
            if (!setupAudioContext()) { throw new Error("無法設定音訊分析器"); }
            const options = { mimeType: 'audio/webm' }; if (!MediaRecorder.isTypeSupported(options.mimeType)) { options.mimeType = 'audio/ogg;codecs=opus'; } if (!MediaRecorder.isTypeSupported(options.mimeType)) { options.mimeType = 'audio/wav'; } if (!MediaRecorder.isTypeSupported(options.mimeType)) { options.mimeType = ''; } console.log("Using MIME:", options.mimeType || 'default');
            mediaRecorder = new MediaRecorder(audioStream, options);
            mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) { audioChunks.push(event.data); } };
            mediaRecorder.onstop = async () => { console.log("MediaRecorder stopped."); isRecording = false; if(recordBtn) recordBtn.classList.remove('recording'); if(recordBtnText) recordBtnText.textContent = "開始錄音"; if(micStatus) micStatus.textContent = "處理中..."; if(recordBtn) recordBtn.disabled = true; clearTimeout(silenceTimer); silenceTimer = null; if (audioChunks.length === 0) { console.warn("No audio."); if(micStatus) micStatus.textContent = "未錄到聲音。"; if(recordBtn) recordBtn.disabled = false; return; } const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/wav' }); audioChunks = []; await transcribeAndSend(audioBlob); if(recordBtn) recordBtn.disabled = false; };
            mediaRecorder.onerror = (event) => { console.error("Recorder Error:", event.error); if(micStatus) micStatus.textContent = `錄音錯誤: ${event.error.name}`; isRecording = false; if(recordBtn) recordBtn.classList.remove('recording'); if(recordBtnText) recordBtnText.textContent = "開始錄音"; clearTimeout(silenceTimer); silenceTimer = null; stopAudioPlayback(); };
            console.log("MediaRecorder setup ok."); return true;
        } catch (err) { console.error("Mic/Setup error:", err); if(micStatus) micStatus.textContent = `麥克風/設定錯誤: ${err.name}. 請檢查權限。`; if(recordBtn) recordBtn.disabled = true; if (voiceToggle) voiceToggle.checked = false; isVoiceModeEnabled = false; if(recordBtn) recordBtn.classList.add('hidden'); return false; }
    }

    function stopMicrophone() {
        if (mediaRecorder && isRecording) { try { mediaRecorder.stop(); } catch(e){ console.error("Error stopping recorder:", e);} } isRecording = false;
        if (audioStream) { audioStream.getTracks().forEach(track => track.stop()); audioStream = null; console.log("Mic stream tracks stopped."); }
        mediaRecorder = null;
        if (microphoneSource) { try { microphoneSource.disconnect(); } catch(e){} microphoneSource = null; console.log("Mic source disconnected.");}
        clearTimeout(silenceTimer); silenceTimer = null; console.log("Mic/Audio resources stopped.");
        if(recordBtn) { recordBtn.disabled = true; recordBtn.classList.add('hidden'); recordBtn.classList.remove('recording'); }
        if(recordBtnText) recordBtnText.textContent = "開始錄音"; if(micStatus) micStatus.textContent = "語音停用";
    }

    function startRecording() {
        if (!mediaRecorder || mediaRecorder.state !== "inactive" || isRecording) { console.warn("Cannot start recording."); return; }
         if (audioContext && audioContext.state === 'suspended') { audioContext.resume().then(() => { console.log("AudioContext resumed."); _startRecordingInternal(); }).catch(e => { console.error("Failed resume AC:", e); if(micStatus) micStatus.textContent = "無法啟動音訊"; }); }
         else if (audioContext && audioContext.state === 'running') { _startRecordingInternal(); }
         else { console.error("AudioContext not ready."); if(micStatus) micStatus.textContent = "音訊未就緒"; }
    }
    function _startRecordingInternal() {
        audioChunks = []; mediaRecorder.start(VAD_CHECK_INTERVAL_MS); isRecording = true; console.log("Recording started (VAD active).");
        if(recordBtn) recordBtn.classList.add('recording'); if(recordBtnText) recordBtnText.textContent = "停止錄音 (靜音自動停止)"; if(micStatus) micStatus.textContent = "聆聽中...";
        stopAudioPlayback(); clearTimeout(silenceTimer); silenceTimer = null;
        requestAnimationFrame(monitorVolume); // Start VAD loop
    }

    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state === "recording") { console.log("Attempting to stop MediaRecorder..."); try { mediaRecorder.stop(); } catch (e) { console.error("Error stopping recorder:", e); isRecording = false; if(recordBtn) recordBtn.classList.remove('recording'); if(recordBtnText) recordBtnText.textContent = "開始錄音"; } }
        else { console.log("Stop recording called but not recording."); }
        clearTimeout(silenceTimer); silenceTimer = null;
    }

    async function transcribeAndSend(audioBlob) {
        const formData = new FormData(); const fileExtension = (audioBlob.type.split('/')[1] || 'wav').split(';')[0]; formData.append('audio_blob', audioBlob, `recording.${fileExtension}`);
        try { const response = await fetch('/transcribe', { method: 'POST', body: formData }); if (!response.ok) { let e = `HTTP ${response.status}`; try { const d = await response.json(); e = d.error||e; } catch(ig){} throw new Error(e); } const result = await response.json(); const transcribedText = result.text; if (transcribedText && transcribedText.trim()) { if(micStatus) micStatus.textContent = `辨識: ${transcribedText.substring(0, 30)}...`; console.log("Transcription:", transcribedText); if (typeof window.sendChatMessage === 'function') { chatInput.value = transcribedText; window.sendChatMessage(); } else { console.error("sendChatMessage is not accessible!"); chatInput.value = transcribedText; if(micStatus) micStatus.textContent = "辨識完成，請手動發送。"; } } else { console.warn("Transcription empty."); if(micStatus) micStatus.textContent = "無法辨識聲音。"; }
        } catch (error) { console.error("Transcription failed:", error); if(micStatus) micStatus.textContent = `辨識失敗: ${error.message || '錯誤'}`; }
    }

    function stopAudioPlayback() { if (currentAudioPlayer) { currentAudioPlayer.pause(); currentAudioPlayer.src = ''; currentAudioPlayer = null; console.log("Stopped TTS playback."); if(micStatus && isVoiceModeEnabled) micStatus.textContent = "就緒。"; } }

    // --- Make playVoiceResponse globally accessible ---
    window.playVoiceResponse = async (text) => {
        if (!isVoiceModeEnabled) { console.log("Voice off, display only."); return; }
        if (!text || !text.trim()) { console.warn("playVoiceResponse called with empty text."); return; }
        console.log("Requesting TTS for playback:", text.substring(0, 50) + "..."); stopAudioPlayback();
        if(micStatus) micStatus.textContent = "正在合成語音...";
        try { const response = await fetch('/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) }); if (!response.ok) { let e = `HTTP ${response.status}`; try { const d = await response.json(); e = d.error||e; } catch(ig){} throw new Error(e); } const audioBlob = await response.blob(); if (audioBlob.size === 0) { throw new Error("Empty audio data."); } const audioUrl = URL.createObjectURL(audioBlob); currentAudioPlayer = new Audio(audioUrl); console.log("Playing TTS audio..."); if(micStatus) micStatus.textContent = "正在播放...";
            currentAudioPlayer.onended = () => { console.log("TTS playback finished."); URL.revokeObjectURL(audioUrl); currentAudioPlayer = null; if(micStatus && isVoiceModeEnabled) micStatus.textContent = "播放完畢。點擊按鈕再次錄音。"; };
            currentAudioPlayer.onerror = (e) => { console.error("Audio playback error:", e); URL.revokeObjectURL(audioUrl); currentAudioPlayer = null; if(micStatus) micStatus.textContent = "播放語音時發生錯誤。"; if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', '播放語音時發生錯誤。', 'error'); } };
            currentAudioPlayer.play();
        } catch (error) { console.error("TTS request failed:", error); if(micStatus) micStatus.textContent = `語音合成失敗: ${error.message || '錯誤'}`; if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', `語音合成失敗: ${error.message || '錯誤'}`, 'error'); } }
    };


    // --- Event Listeners ---
    if (voiceToggle) {
        voiceToggle.addEventListener('change', async () => {
            if (voiceToggle.checked) { isVoiceModeEnabled = true; console.log("Voice mode ENABLED"); if(recordBtn) recordBtn.classList.remove('hidden'); if(micStatus) micStatus.textContent = "啟用麥克風..."; const setupSuccess = await setupAudioRecorder(); if (!setupSuccess) { isVoiceModeEnabled = false; voiceToggle.checked = false; } else { if(recordBtnText) recordBtnText.textContent = "開始錄音"; if(micStatus) micStatus.textContent = "就緒。點擊按鈕開始。"; } }
            else { isVoiceModeEnabled = false; console.log("Voice mode DISABLED"); stopMicrophone(); stopAudioPlayback(); }
        });
    }

    // Record Button - Toggle Start/Stop
    if (recordBtn) {
         recordBtn.addEventListener('click', (e) => {
             if (!isVoiceModeEnabled || !mediaRecorder || recordBtn.disabled) return; e.preventDefault();
             if (!isRecording) { startRecording(); } else { stopRecording(); } // Manual stop
         });
    }

    // Global click listener to hide tooltip (ensure elements exist)
    document.addEventListener('click', (event) => {
        const localTooltip = document.getElementById('translation-tooltip'); // Re-get ref just in case
        const localContainer = document.getElementById('pdf-viewer-container');
        if (localTooltip && localTooltip.style.display !== 'none') {
            if (!localTooltip.contains(event.target) && localContainer && !localContainer.contains(event.target)) {
                 console.log("Clicked outside viewer/tooltip, hiding tooltip.");
                 hideTranslationTooltip(); // Assumes hideTranslationTooltip is accessible
            }
        }
    });

    console.log("Voice script event listeners added.");

}); // End of DOMContentLoaded listener
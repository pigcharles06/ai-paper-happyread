document.addEventListener('DOMContentLoaded', () => {
    console.log("Voice script loaded and DOM ready.");

    // --- DOM Elements ---
    const voiceToggle = document.getElementById('voice-toggle');
    const recordBtn = document.getElementById('record-btn');
    const recordBtnText = document.getElementById('record-btn-text');
    const micStatus = document.getElementById('mic-status');
    const chatInput = document.getElementById('chat-input'); // Needed to potentially insert text

    // --- State Variables ---
    let isVoiceModeEnabled = false;
    let mediaRecorder = null;
    let audioChunks = [];
    let audioStream = null;
    let isRecording = false;
    let currentAudioPlayer = null; // For TTS playback control

    // --- VAD Variables ---
    let audioContext = null;
    let analyser = null;
    let microphoneSource = null;
    let silenceTimer = null;
    const SILENCE_THRESHOLD = 0.01; // Adjust based on mic sensitivity
    const SILENCE_DELAY_MS = 1500; // 1.5 seconds
    const VAD_CHECK_INTERVAL_MS = 200; // Check volume frequency

    // --- Check browser support and element existence ---
    window.AudioContext = window.AudioContext || window.webkitAudioContext; // Cross-browser
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { console.error("getUserMedia unsupported!"); if (voiceToggle) voiceToggle.disabled = true; if (micStatus) micStatus.textContent = "錯誤：瀏覽器不支援麥克風。"; return; }
    if (!window.MediaRecorder) { console.error("MediaRecorder unsupported!"); if (voiceToggle) voiceToggle.disabled = true; if (micStatus) micStatus.textContent = "錯誤：瀏覽器不支援錄音。"; return; }
    if (!window.AudioContext) { console.error("AudioContext unsupported!"); if (voiceToggle) voiceToggle.disabled = true; if (micStatus) micStatus.textContent = "錯誤：音訊處理不支持。"; return; }
    // Ensure all required elements are found
    if (!voiceToggle || !recordBtn || !recordBtnText || !micStatus || !chatInput) { console.error("One or more voice control elements not found (voice.js)."); if (voiceToggle) voiceToggle.disabled = true; return; }

    // --- Core Audio Functions ---

    /** Setup AudioContext and Analyser for VAD */
    function setupAudioContext() {
        try {
            // Create or resume AudioContext
            if (!audioContext || audioContext.state === 'closed') {
                audioContext = new AudioContext();
                console.log("AudioContext created/recreated.");
            }
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => console.log("AudioContext resumed."));
            }
            // Create Analyser if needed
            if (!analyser) {
                analyser = audioContext.createAnalyser();
                analyser.fftSize = 2048; // Standard size
                analyser.smoothingTimeConstant = 0.8; // Some smoothing
                console.log("AnalyserNode created.");
            }
            // Connect Microphone Stream to Analyser
            // Disconnect previous source if exists and stream is valid
            if (microphoneSource && audioStream) {
                 try { microphoneSource.disconnect(); } catch(e){} // Ignore errors if already disconnected
                 microphoneSource = audioContext.createMediaStreamSource(audioStream);
                 microphoneSource.connect(analyser);
                 console.log("Mic source reconnected to analyser.");
            } else if (!microphoneSource && audioStream) { // Connect if first time
                 microphoneSource = audioContext.createMediaStreamSource(audioStream);
                 microphoneSource.connect(analyser);
                 console.log("Mic source connected to analyser.");
            }
            return true; // Success
        } catch (err) {
            console.error("AudioContext/Analyser setup error:", err);
            if(micStatus) micStatus.textContent = "音訊分析器錯誤";
            return false; // Failure
        }
    }

    /** Check audio volume level periodically for VAD */
    function monitorVolume() {
        // Stop monitoring if no longer recording or resources unavailable
        if (!isRecording || !analyser || !audioContext || audioContext.state !== 'running') {
             clearTimeout(silenceTimer); // Ensure timer is cleared if monitoring stops abruptly
             silenceTimer = null;
             return;
        }

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        try {
            analyser.getByteTimeDomainData(dataArray); // Get waveform data
        } catch (e) {
             console.error("VAD Error getting audio data:", e);
             // Potentially stop recording or alert user?
             return; // Stop monitoring this frame
        }

        // Calculate RMS value to estimate volume
        let sumSquares = 0.0;
        for (const amplitude of dataArray) {
            const normalizedAmplitude = (amplitude / 128.0) - 1.0; // Normalize to -1.0 to 1.0
            sumSquares += normalizedAmplitude * normalizedAmplitude;
        }
        const rms = Math.sqrt(sumSquares / bufferLength);
        // console.log("RMS:", rms.toFixed(4)); // Uncomment for debugging volume level

        // Check against silence threshold
        if (rms > SILENCE_THRESHOLD) {
            // Sound detected - reset silence timer if running
            if (silenceTimer) {
                // console.log("Sound detected, resetting silence timer.");
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
        } else {
            // Silence detected - start timer if not already running
            if (!silenceTimer) {
                 // console.log("Silence detected, starting timer...");
                 silenceTimer = setTimeout(() => {
                     console.log(`Silence detected for ${SILENCE_DELAY_MS}ms. Stopping recording via VAD.`);
                     stopRecording(); // Stop recording after silence delay
                     silenceTimer = null; // Clear timer ID
                 }, SILENCE_DELAY_MS);
             }
             // else: Silence continues, timer is running...
        }

        // Request next frame for continuous monitoring while recording
        requestAnimationFrame(monitorVolume);
    }


    /** Request microphone permission and setup MediaRecorder and VAD */
    async function setupAudioRecorder() {
        try {
            if(micStatus) micStatus.textContent = "請求麥克風權限...";
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if(micStatus) micStatus.textContent = "權限已獲取，準備。";
            if(recordBtn) recordBtn.disabled = false;

            // Setup AudioContext for VAD using the obtained stream
            if (!setupAudioContext()) {
                 throw new Error("無法設定音訊分析器");
            }

            // Setup MediaRecorder
            const options = { mimeType: 'audio/webm' }; // Prefer webm
             if (!MediaRecorder.isTypeSupported(options.mimeType)) { options.mimeType = 'audio/ogg;codecs=opus'; }
             if (!MediaRecorder.isTypeSupported(options.mimeType)) { options.mimeType = 'audio/wav'; } // Fallback to wav
             if (!MediaRecorder.isTypeSupported(options.mimeType)) { options.mimeType = ''; } // Let browser choose
             console.log("Using MediaRecorder MIME Type:", options.mimeType || 'browser default');

            mediaRecorder = new MediaRecorder(audioStream, options);

            // Event Handlers for MediaRecorder
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) { audioChunks.push(event.data); }
            };

            mediaRecorder.onstop = async () => {
                console.log("MediaRecorder stopped.");
                isRecording = false; // Update state
                if(recordBtn) { recordBtn.classList.remove('recording'); recordBtn.disabled = true; } // Update button state visually first
                if(recordBtnText) recordBtnText.textContent = "開始錄音";
                if(micStatus) micStatus.textContent = "錄音結束，處理中...";
                clearTimeout(silenceTimer); silenceTimer = null; // Ensure VAD timer is cleared

                if (audioChunks.length === 0) {
                    console.warn("No audio chunks recorded.");
                    if(micStatus) micStatus.textContent = "未錄到聲音，請重試。";
                    if(recordBtn) recordBtn.disabled = false; // Re-enable button
                    return;
                }
                // Process recorded audio
                const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/wav' });
                audioChunks = []; // Clear chunks immediately
                await transcribeAndSend(audioBlob); // Send for transcription
                if(recordBtn) recordBtn.disabled = false; // Re-enable button after processing
            };

            mediaRecorder.onerror = (event) => {
                console.error("MediaRecorder Error:", event.error);
                if(micStatus) micStatus.textContent = `錄音錯誤: ${event.error.name}`;
                isRecording = false; recordBtn.classList.remove('recording'); if(recordBtnText) recordBtnText.textContent = "開始錄音";
                clearTimeout(silenceTimer); silenceTimer = null; stopAudioPlayback();
            };

            console.log("MediaRecorder setup complete.");
            return true; // Success

        } catch (err) {
            console.error("Microphone/Setup error:", err);
            if(micStatus) micStatus.textContent = `麥克風/設定錯誤: ${err.name}. 請檢查瀏覽器權限。`;
            if(recordBtn) recordBtn.disabled = true; if (voiceToggle) voiceToggle.checked = false;
            isVoiceModeEnabled = false; if(recordBtn) recordBtn.classList.add('hidden');
            return false; // Failure
        }
    }

    /** Stop microphone access and release associated resources */
    function stopMicrophone() {
        // Stop recorder if running
        if (mediaRecorder && isRecording) {
            try { mediaRecorder.stop(); } catch(e){ console.error("Error stopping recorder during cleanup:", e);}
        }
        isRecording = false;

        // Stop media stream tracks
        if (audioStream) {
            audioStream.getTracks().forEach(track => track.stop());
            audioStream = null;
            console.log("Microphone stream tracks stopped.");
        }
        mediaRecorder = null; // Clear recorder instance

        // Disconnect AudioContext source
        if (microphoneSource) {
            try { microphoneSource.disconnect(); } catch(e){}
            microphoneSource = null;
            console.log("Microphone source disconnected from analyser.");
        }
        // We typically don't close the AudioContext, just stop using it.

        // Clear VAD timer
        clearTimeout(silenceTimer); silenceTimer = null;

        console.log("Microphone and audio resources stopped/disconnected.");
        // Update UI
        if(recordBtn) { recordBtn.disabled = true; recordBtn.classList.add('hidden'); recordBtn.classList.remove('recording'); }
        if(recordBtnText) recordBtnText.textContent = "開始錄音";
        if(micStatus) micStatus.textContent = "語音模式已停用";
    }

    /** Start recording audio and VAD monitoring */
    function startRecording() {
        if (!mediaRecorder || mediaRecorder.state !== "inactive" || isRecording) {
            console.warn("Cannot start recording: Recorder not ready or already active.");
            return;
        }
         // Ensure AudioContext is running (required for analyser)
         if (audioContext && audioContext.state === 'suspended') {
             audioContext.resume().then(() => {
                 console.log("AudioContext resumed for recording.");
                 _startRecordingInternal(); // Start actual recording after resume
             }).catch(e => {
                 console.error("Failed to resume AudioContext for recording:", e);
                 if(micStatus) micStatus.textContent = "無法啟動音訊環境";
             });
         } else if (audioContext && audioContext.state === 'running') {
             _startRecordingInternal(); // Start if already running
         } else {
             console.error("AudioContext not ready for recording.");
             if(micStatus) micStatus.textContent = "音訊環境未就緒";
         }
    }
    // Internal helper to start recorder and monitoring
    function _startRecordingInternal() {
        audioChunks = []; // Clear previous chunks
        mediaRecorder.start(VAD_CHECK_INTERVAL_MS); // Start recording, trigger data periodically
        isRecording = true;
        console.log("Recording started (VAD active).");
        // Update UI
        if(recordBtn) recordBtn.classList.add('recording');
        if(recordBtnText) recordBtnText.textContent = "停止錄音 (靜音自動停止)";
        if(micStatus) micStatus.textContent = "聆聽中...";
        // Stop any ongoing TTS
        stopAudioPlayback();
        // Reset and start VAD timer/monitoring
        clearTimeout(silenceTimer); silenceTimer = null;
        requestAnimationFrame(monitorVolume); // Start the VAD check loop
    }


    /** Stop recording audio (manually or via VAD) */
    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state === "recording") {
            console.log("Attempting to stop MediaRecorder...");
            try {
                mediaRecorder.stop(); // This will trigger the 'onstop' event handler
            } catch (e) {
                 console.error("Error stopping mediaRecorder:", e);
                 // Manually reset state if stop fails critically
                 isRecording = false;
                 if(recordBtn) recordBtn.classList.remove('recording');
                 if(recordBtnText) recordBtnText.textContent = "開始錄音";
                 clearTimeout(silenceTimer); silenceTimer = null;
            }
        } else {
            console.log("Stop recording called but recorder not active.");
            // Ensure timer is cleared even if not recording
            clearTimeout(silenceTimer); silenceTimer = null;
        }
        // Actual state change (isRecording = false) happens in the onstop handler
    }

    /** Send audio blob to backend for STT and trigger chat */
    async function transcribeAndSend(audioBlob) {
        const formData = new FormData();
        const fileExtension = (audioBlob.type.split('/')[1] || 'wav').split(';')[0];
        formData.append('audio_blob', audioBlob, `recording.${fileExtension}`);
        try {
            const response = await fetch('/transcribe', { method: 'POST', body: formData });
            if (!response.ok) { let e = `HTTP ${response.status}`; try { const d = await response.json(); e = d.error||e; } catch(ig){} throw new Error(e); }
            const result = await response.json();
            const transcribedText = result.text;
            if (transcribedText && transcribedText.trim()) {
                if(micStatus) micStatus.textContent = `辨識: ${transcribedText.substring(0, 30)}...`;
                console.log("Transcription:", transcribedText);
                // Use globally exposed sendChatMessage from main.js
                if (typeof window.sendChatMessage === 'function') {
                    chatInput.value = transcribedText; // Put text in input
                    window.sendChatMessage(); // Trigger chat send
                } else {
                    console.error("sendChatMessage function is not accessible!");
                    chatInput.value = transcribedText; // Fallback: just put text in input
                    if(micStatus) micStatus.textContent = "辨識完成，請手動發送。";
                }
            } else {
                console.warn("Transcription returned empty text.");
                if(micStatus) micStatus.textContent = "無法辨識聲音，請重試。";
            }
        } catch (error) {
            console.error("Transcription request failed:", error);
            if(micStatus) micStatus.textContent = `辨識失敗: ${error.message || '錯誤'}`;
        }
    }

    /** Stop any currently playing TTS audio */
    function stopAudioPlayback() {
        if (currentAudioPlayer) {
            currentAudioPlayer.pause();
            // Revoke object URL maybe? Or just reset src
            currentAudioPlayer.src = ''; // Setting src to empty often stops loading/playback
            currentAudioPlayer = null;
            console.log("Stopped previous TTS playback.");
            if(micStatus && isVoiceModeEnabled) micStatus.textContent = "就緒。"; // Update status if relevant
        }
    }

    /** Public function for TTS (called by main.js) */
    // Make this globally accessible
    window.playVoiceResponse = async (text) => {
        if (!isVoiceModeEnabled) { // Check if voice mode is still active
            console.log("Voice mode disabled, skipping TTS playback.");
            // Text is already displayed by main.js, so do nothing here
            return;
        }
        if (!text || !text.trim()) { console.warn("playVoiceResponse called with empty text."); return; }

        console.log("Requesting TTS for playback:", text.substring(0, 50) + "...");
        stopAudioPlayback(); // Stop previous before starting new
        if(micStatus) micStatus.textContent = "正在合成語音...";

        try {
            const response = await fetch('/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) });
            if (!response.ok) { let e = `HTTP ${response.status}`; try { const d = await response.json(); e = d.error||e; } catch(ig){} throw new Error(e); }

            const audioBlob = await response.blob();
            if (audioBlob.size === 0) { throw new Error("Received empty audio data."); }
            const audioUrl = URL.createObjectURL(audioBlob);

            currentAudioPlayer = new Audio(audioUrl);
            console.log("Playing synthesized audio...");
            if(micStatus) micStatus.textContent = "正在播放...";

            currentAudioPlayer.onended = () => {
                console.log("TTS playback finished.");
                URL.revokeObjectURL(audioUrl); currentAudioPlayer = null;
                if(micStatus && isVoiceModeEnabled) micStatus.textContent = "播放完畢。點擊按鈕再次錄音。"; // Ready for next input
                // Text is already displayed by main.js
                // Potential place to re-enable listening automatically if desired
            };
            currentAudioPlayer.onerror = (e) => {
                console.error("Audio playback error:", e); URL.revokeObjectURL(audioUrl); currentAudioPlayer = null;
                if(micStatus) micStatus.textContent = "播放語音時發生錯誤。";
                // Text is already displayed, maybe add system error message?
                if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', '播放語音時發生錯誤。', 'error'); }
            };
            currentAudioPlayer.play();

        } catch (error) {
            console.error("Speech synthesis request failed:", error);
            if(micStatus) micStatus.textContent = `語音合成失敗: ${error.message || '錯誤'}`;
            // Text is already displayed, maybe add system error message?
            if (typeof window.addChatMessage === 'function') { window.addChatMessage('system', `語音合成失敗: ${error.message || '錯誤'}`, 'error'); }
        }
    };


    // --- Event Listeners ---
    if (voiceToggle) {
        voiceToggle.addEventListener('change', async () => {
            if (voiceToggle.checked) {
                isVoiceModeEnabled = true; console.log("Voice mode ENABLED");
                if(recordBtn) recordBtn.classList.remove('hidden');
                if(micStatus) micStatus.textContent = "啟用麥克風...";
                const setupSuccess = await setupAudioRecorder();
                if (!setupSuccess) { isVoiceModeEnabled = false; voiceToggle.checked = false; }
                else { if(recordBtnText) recordBtnText.textContent = "開始錄音"; if(micStatus) micStatus.textContent = "就緒。點擊按鈕開始。"; }
            } else {
                isVoiceModeEnabled = false; console.log("Voice mode DISABLED");
                stopMicrophone(); stopAudioPlayback(); // Stop everything
            }
        });
    }

    // Record Button - Toggle Start/Stop
    if (recordBtn) {
         recordBtn.addEventListener('click', (e) => {
             if (!isVoiceModeEnabled || !mediaRecorder || recordBtn.disabled) return;
             e.preventDefault();
             if (!isRecording) { startRecording(); }
             else { stopRecording(); } // Manual stop
         });
    }

    // Global click listener to hide tooltip (from main.js, but check elements exist)
    document.addEventListener('click', (event) => {
        if (translationTooltip && translationTooltip.style.display !== 'none') {
            if (!translationTooltip.contains(event.target) && pdfViewerContainer && !pdfViewerContainer.contains(event.target)) {
                 console.log("Clicked outside viewer/tooltip, hiding tooltip.");
                 hideTranslationTooltip(); // Assumes hideTranslationTooltip is accessible (defined in main.js)
            }
        }
    });


    console.log("Voice script event listeners added.");

}); // End of DOMContentLoaded listener
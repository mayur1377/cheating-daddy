// renderer.js
const { ipcRenderer } = require('electron');

let mediaStream = null;
let screenshotInterval = null;
let audioContext = null;
let audioProcessor = null;
let micAudioProcessor = null;
let micAudioContext = null;
let micStream = null;
let audioBuffer = [];
let isMicrophoneCaptureActive = false;
// Global references to audio buffers for cleanup
let micAudioBuffer = [];
let micSendBuffer = [];
const SAMPLE_RATE = 24000;
const AUDIO_CHUNK_DURATION = 0.08; // Balanced for quality vs latency
const BUFFER_SIZE = 2048; // Balanced buffer size for microphone quality

// Microphone settings aligned with speaker audio for consistency
const MIC_SAMPLE_RATE = 24000; // Same as SAMPLE_RATE for consistency
const MIC_CHUNK_DURATION = 0.08; // Reduced from 0.2s to 0.08s for faster transcription response
const MIC_BUFFER_SIZE = 1024; // Match speaker audio buffer size for consistency

// Smart Audio Router for automatic speaker detection and switching
class SmartAudioRouter {
    constructor() {
        this.recentActivity = {
            interviewer: [],
            interviewee: []
        };
        this.currentSpeaker = null;
        this.switchCooldown = 200; // 200ms cooldown between switches - more responsive
        this.lastSwitch = 0;
        this.vadThreshold = {
            interviewer: 0.01,  // Higher threshold for speaker audio
            interviewee: 0.003  // Much lower threshold for microphone
        };
        console.log('🎯 SmartAudioRouter initialized');
    }

    enhancedVAD(audioData, source) {
        const rms = calculateRMS(audioData);
        const silencePercentage = calculateSilencePercentage(audioData);
        
        // Source-specific thresholds
        const threshold = this.vadThreshold[source];
        const maxSilence = source === 'interviewer' ? 80 : 85;
        
        const hasVoice = rms > threshold && silencePercentage < maxSilence;
        
        // Better confidence calculation
        let confidence = 0;
        if (hasVoice) {
            // Normalize confidence based on threshold
            const normalizedRms = Math.min(rms / threshold, 10); // Cap at 10x threshold
            confidence = Math.min(normalizedRms * 0.2, 1.0); // Scale to 0-1
        }
        
        return {
            hasVoice,
            confidence,
            source,
            rms,
            silencePercentage
        };
    }

    processAudioChunk(audioData, source) {
        const vad = this.enhancedVAD(audioData, source);
        const now = Date.now();
        
        // Check if microphone is disabled for interviewee audio
        if (source === 'interviewee' && !isMicrophoneCaptureActive) {
            return false; // Don't process microphone audio when mic is toggled off
        }
        
        // Simplified debug for microphone
        if (source === 'interviewee' && vad.hasVoice) {
            process.stdout.write(`V`); // Voice detected
        }
        
        // Track recent activity
        this.recentActivity[source].push({
            timestamp: now,
            hasVoice: vad.hasVoice,
            confidence: vad.confidence
        });
        
        // Clean old activity (keep last 2 seconds)
        this.recentActivity[source] = this.recentActivity[source]
            .filter(activity => now - activity.timestamp < 2000);
        
        // Determine if this source should be active
        const shouldBeActive = this.shouldActivateSource(source, vad);
        
        if (shouldBeActive && this.canSwitch(now)) {
            this.switchToSource(source);
        }
        
        // Send audio if voice detected and this source should be active
        if (vad.hasVoice && shouldBeActive) {
            this.sendAudioChunk(audioData, source);
            return true; // Audio was sent
        }
        
        return false; // Audio was not sent
    }
    
    shouldActivateSource(source, vad) {
        if (!vad.hasVoice) return false;
        
        // If no current speaker, activate if voice detected
        if (!this.currentSpeaker) return true;
        
        // If same source, continue if voice active
        if (this.currentSpeaker === source) return true;
        
        // Switch if other source has reasonable signal
        const otherSource = source === 'interviewer' ? 'interviewee' : 'interviewer';
        const otherActivity = this.getRecentActivity(otherSource);
        
        // Much more permissive switching - prioritize any voice activity
        return vad.confidence > 0.1 && otherActivity < 0.5;
    }
    
    getRecentActivity(source) {
        const recent = this.recentActivity[source]
            .filter(a => a.hasVoice)
            .slice(-5); // Last 5 voice detections
        
        if (recent.length === 0) return 0;
        
        return recent.reduce((sum, a) => sum + a.confidence, 0) / recent.length;
    }
    
    canSwitch(now) {
        return now - this.lastSwitch > this.switchCooldown;
    }
    
    switchToSource(source) {
        if (this.currentSpeaker !== source) {
            console.log(`🔄 Switching audio focus to: ${source}`);
            this.currentSpeaker = source;
            this.lastSwitch = Date.now();
            
            // Update UI indicator if available
            this.updateAudioSourceIndicator(source);
        }
    }
    
    updateAudioSourceIndicator(source) {
        // Dispatch custom event for UI updates
        const event = new CustomEvent('audioSourceChanged', {
            detail: {
                activeSource: source,
                timestamp: Date.now()
            }
        });
        window.dispatchEvent(event);
        
        // Also update any existing status elements
        const statusElement = document.querySelector('#audio-source-status');
        if (statusElement) {
            statusElement.textContent = source === 'interviewer' ? '🔊 Speaker Active' : '🎤 Microphone Active';
            statusElement.className = `audio-status ${source}`;
        }
    }
    
    getCurrentSpeaker() {
        return this.currentSpeaker;
    }
    
    getActivityStats() {
        return {
            interviewer: this.getRecentActivity('interviewer'),
            interviewee: this.getRecentActivity('interviewee'),
            currentSpeaker: this.currentSpeaker,
            lastSwitch: this.lastSwitch
        };
    }
    
    sendAudioChunk(audioData, source) {
        // Convert to WAV format for better compatibility
        const sampleRate = source === 'interviewer' ? SAMPLE_RATE : MIC_SAMPLE_RATE;
        const wavBuffer = createWavBuffer(audioData, sampleRate);
        const base64Data = arrayBufferToBase64(wavBuffer);
        
        console.log(`🎵 Sending ${source} audio: ${audioData.length} samples, ${(audioData.length / sampleRate).toFixed(2)}s duration`);
        
        ipcRenderer.invoke('send-audio-content', {
            data: base64Data,
            mimeType: 'audio/wav',
            source: source === 'interviewer' ? 'interviewer' : 'interviewee'
        }).catch(error => {
            console.warn(`Audio send failed for ${source}:`, error.message);
        });
    }
}

// Global audio router instance
let audioRouter = null;

// Real-time audio optimization:
// - Different settings for mic vs speaker audio
// - Non-blocking audio processing with setImmediate
// - Optimized Gemini transcription settings

let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;
let currentImageQuality = 'medium'; // Store current image quality for manual screenshots

// Linux platform detection commented out - Windows only deployment
// const isLinux = process.platform === 'linux';
const isMacOS = process.platform === 'darwin';

// Token tracking system for rate limiting
let tokenTracker = {
    tokens: [], // Array of {timestamp, count, type} objects
    audioStartTime: null,

    // Add tokens to the tracker
    addTokens(count, type = 'image') {
        const now = Date.now();
        this.tokens.push({
            timestamp: now,
            count: count,
            type: type,
        });

        // Clean old tokens (older than 1 minute)
        this.cleanOldTokens();
    },

    // Calculate image tokens based on Gemini 2.0 rules
    calculateImageTokens(width, height) {
        // Images ≤384px in both dimensions = 258 tokens
        if (width <= 384 && height <= 384) {
            return 258;
        }

        // Larger images are tiled into 768x768 chunks, each = 258 tokens
        const tilesX = Math.ceil(width / 768);
        const tilesY = Math.ceil(height / 768);
        const totalTiles = tilesX * tilesY;

        return totalTiles * 258;
    },

    // Track audio tokens continuously
    trackAudioTokens() {
        if (!this.audioStartTime) {
            this.audioStartTime = Date.now();
            return;
        }

        const now = Date.now();
        const elapsedSeconds = (now - this.audioStartTime) / 1000;

        // Audio = 32 tokens per second
        const audioTokens = Math.floor(elapsedSeconds * 32);

        if (audioTokens > 0) {
            this.addTokens(audioTokens, 'audio');
            this.audioStartTime = now;
        }
    },

    // Clean tokens older than 1 minute
    cleanOldTokens() {
        const oneMinuteAgo = Date.now() - 60 * 1000;
        this.tokens = this.tokens.filter(token => token.timestamp > oneMinuteAgo);
    },

    // Get total tokens in the last minute
    getTokensInLastMinute() {
        this.cleanOldTokens();
        return this.tokens.reduce((total, token) => total + token.count, 0);
    },

    // Check if we should throttle based on settings
    shouldThrottle() {
        // Get rate limiting settings from localStorage
        const throttleEnabled = localStorage.getItem('throttleTokens') === 'true';
        if (!throttleEnabled) {
            return false;
        }

        const maxTokensPerMin = parseInt(localStorage.getItem('maxTokensPerMin') || '1000000', 10);
        const throttleAtPercent = parseInt(localStorage.getItem('throttleAtPercent') || '75', 10);

        const currentTokens = this.getTokensInLastMinute();
        const throttleThreshold = Math.floor((maxTokensPerMin * throttleAtPercent) / 100);

        console.log(`Token check: ${currentTokens}/${maxTokensPerMin} (throttle at ${throttleThreshold})`);

        return currentTokens >= throttleThreshold;
    },

    // Reset the tracker
    reset() {
        this.tokens = [];
        this.audioStartTime = null;
    },
};

// Track audio tokens every few seconds
setInterval(() => {
    tokenTracker.trackAudioTokens();
}, 2000);

function cheddarElement() {
    return document.getElementById('cheddar');
}

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        // Improved scaling to prevent clipping
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

// Voice Activity Detection helper functions
function calculateRMS(float32Array) {
    let sum = 0;
    for (let i = 0; i < float32Array.length; i++) {
        sum += float32Array[i] * float32Array[i];
    }
    return Math.sqrt(sum / float32Array.length);
}

function calculateSilencePercentage(float32Array) {
    let silentSamples = 0;
    const threshold = 0.005; // More sensitive threshold for microphone audio
    
    for (let i = 0; i < float32Array.length; i++) {
        if (Math.abs(float32Array[i]) < threshold) {
            silentSamples++;
        }
    }
    
    return (silentSamples / float32Array.length) * 100;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Create WAV buffer from Float32Array
function createWavBuffer(float32Array, sampleRate) {
    const length = float32Array.length;
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length * 2, true);
    
    // Convert float32 to int16 and write to buffer
    let offset = 44;
    for (let i = 0; i < length; i++) {
        const sample = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
    }
    
    return buffer;
}

async function initializeGemini(profile = 'interview', language = 'en-US') {
    const apiKey = localStorage.getItem('apiKey')?.trim();
    if (apiKey) {
        const success = await ipcRenderer.invoke('initialize-gemini', apiKey, localStorage.getItem('customPrompt') || '', profile, language);
        if (success) {
            cheddar.e().setStatus('Live');
        } else {
            cheddar.e().setStatus('error');
        }
    }
}

// Listen for status updates
ipcRenderer.on('update-status', (event, status) => {
    console.log('Status update:', status);
    cheddar.e().setStatus(status);
});

// Listen for responses - REMOVED: This is handled in AssistantApp.js to avoid duplicates
// ipcRenderer.on('update-response', (event, response) => {
//     console.log('Gemini response:', response);
//     cheddar.e().setResponse(response);
//     // You can add UI elements to display the response if needed
// });

async function startCapture(screenshotIntervalSeconds = 5, imageQuality = 'medium') {
    // Store the image quality for manual screenshots
    currentImageQuality = imageQuality;

    // Reset token tracker when starting new capture session
    tokenTracker.reset();
    console.log('🎯 Token tracker reset for new capture session');

    try {
        // Initialize smart audio router for automatic speaker detection
        audioRouter = new SmartAudioRouter();
        console.log('🎯 Smart audio routing enabled');

        if (isMacOS) {
            // On macOS, use SystemAudioDump for audio and getDisplayMedia for screen
            console.log('Starting macOS capture with SystemAudioDump...');

            // Start macOS audio capture
            const audioResult = await ipcRenderer.invoke('start-macos-audio');
            if (!audioResult.success) {
                throw new Error('Failed to start macOS audio capture: ' + audioResult.error);
            }

            // Get screen capture for screenshots
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 1,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false, // Don't use browser audio on macOS
            });

            console.log('macOS screen capture started - audio handled by SystemAudioDump');
        // Linux functionality commented out - Windows only deployment
        // } else if (isLinux) {
        //     // Linux - use display media for screen capture and getUserMedia for microphone
        //     mediaStream = await navigator.mediaDevices.getDisplayMedia({
        //         video: {
        //             frameRate: 1,
        //             width: { ideal: 1920 },
        //             height: { ideal: 1080 },
        //         },
        //         audio: false, // Don't use system audio loopback on Linux
        //     });

        //     // Get microphone input for Linux
        //     let micStream = null;
        //     try {
        //         micStream = await navigator.mediaDevices.getUserMedia({
        //             audio: {
        //                 sampleRate: SAMPLE_RATE,
        //                 channelCount: 1,
        //                 echoCancellation: true,
        //                 noiseSuppression: true,
        //                 autoGainControl: true,
        //             },
        //             video: false,
        //         });

        //         console.log('Linux microphone capture started');

        //         // Setup audio processing for microphone on Linux - commented out for Windows-only deployment
        //         // setupLinuxMicProcessing(micStream);
        //     } catch (micError) {
        //         console.warn('Failed to get microphone access on Linux:', micError);
        //         // Continue without microphone if permission denied
        //     }

        //     console.log('Linux screen capture started');
        } else {
            // Windows - use display media with loopback for system audio
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 1,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: {
                    sampleRate: SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            console.log('Windows capture started with loopback audio');

            // Setup audio processing for Windows loopback audio (interviewer)
            setupWindowsLoopbackProcessing();
            
            // Note: Microphone capture will be started manually when user toggles mic button
            console.log('🎤 System audio capture active. Microphone can be toggled independently.');
        }

        console.log('MediaStream obtained:', {
            hasVideo: mediaStream.getVideoTracks().length > 0,
            hasAudio: mediaStream.getAudioTracks().length > 0,
            videoTrack: mediaStream.getVideoTracks()[0]?.getSettings(),
        });

        // Start capturing screenshots - check if manual mode
        if (screenshotIntervalSeconds === 'manual' || screenshotIntervalSeconds === 'Manual') {
            console.log('Manual mode enabled - screenshots will be captured on demand only');
            // Don't start automatic capture in manual mode
        } else {
            const intervalMilliseconds = parseInt(screenshotIntervalSeconds) * 1000;
            screenshotInterval = setInterval(() => captureScreenshot(imageQuality), intervalMilliseconds);

            // Capture first screenshot immediately
            setTimeout(() => captureScreenshot(imageQuality), 100);
        }
    } catch (err) {
        console.error('Error starting capture:', err);
        cheddar.e().setStatus('error');
    }
}

// Linux-specific functionality commented out - Windows only deployment
// function setupLinuxMicProcessing(micStream) {
//     // Setup microphone audio processing for Linux with buffering like other audio sources
//     const micAudioContext = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
//     const micSource = micAudioContext.createMediaStreamSource(micStream);
//     const micProcessor = micAudioContext.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);

//     let audioBuffer = [];
//     let sendBuffer = []; // Buffer to accumulate chunks before sending
//     const samplesPerChunk = MIC_SAMPLE_RATE * MIC_CHUNK_DURATION;
//     const SEND_BUFFER_DURATION = 2.0; // Match other audio sources
//     const chunksPerSend = Math.ceil(SEND_BUFFER_DURATION / MIC_CHUNK_DURATION);
//     let chunkCount = 0;
//     let lastSendTime = Date.now();
//     const SEND_TIMEOUT = 3000; // Match other audio sources

//     micProcessor.onaudioprocess = e => {
//         const inputData = e.inputBuffer.getChannelData(0);
//         audioBuffer.push(...inputData);

//         // Process audio in chunks with buffering
//         while (audioBuffer.length >= samplesPerChunk) {
//             const chunk = audioBuffer.splice(0, samplesPerChunk);
            
//             // Add chunk to send buffer to maintain continuity
//             sendBuffer.push(...chunk);
//             chunkCount++;
            
//             // Send accumulated buffer when we have enough chunks or after timeout
//             const now = Date.now();
//             const shouldSendByTimeout = sendBuffer.length > 0 && (now - lastSendTime) > SEND_TIMEOUT;
            
//             if (chunkCount >= chunksPerSend || shouldSendByTimeout) {
//                 if (sendBuffer.length > 0) {
//                     const float32SendChunk = new Float32Array(sendBuffer);
//                     const pcmData16 = convertFloat32ToInt16(float32SendChunk);
                    
//                     // Apply Voice Activity Detection to the accumulated buffer
//                     const rmsValue = calculateRMS(float32SendChunk);
//                     const silencePercentage = calculateSilencePercentage(float32SendChunk);
                    
//                     // Only send audio if it contains voice activity
//                     if (rmsValue > 0.005 && silencePercentage < 70) {
//                         const base64Data = arrayBufferToBase64(pcmData16.buffer);
                        
//                         ipcRenderer.invoke('send-audio-content', {
//                             data: base64Data,
//                             mimeType: 'audio/pcm;rate=24000',
//                             source: 'interviewee' // Microphone audio
//                         }).catch(error => {
//                             console.warn('Linux microphone audio send failed:', error.message);
//                         });
//                     }
                    
//                     // Reset buffers and timer
//                     sendBuffer = [];
//                     chunkCount = 0;
//                     lastSendTime = now;
//                 }
//             }
//         }
//     };

//     micSource.connect(micProcessor);
//     micProcessor.connect(micAudioContext.destination);

//     // Store processor reference for cleanup
//     audioProcessor = micProcessor;
// }

// New function to start microphone capture independently
async function startMicrophoneCapture() {
    if (isMicrophoneCaptureActive) {
        console.log('Microphone capture already active');
        return { success: true };
    }

    console.log('🎤 Starting microphone capture...');
    
    try {
        // Check if getUserMedia is available
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('getUserMedia is not supported in this browser');
        }
        
        console.log('🎤 Requesting microphone access...');
        
        // Get microphone access with optimized settings for transcription
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: MIC_SAMPLE_RATE, // Use exact microphone sample rate
                channelCount: 1,
                echoCancellation: false,  // Disable to preserve speech clarity
                noiseSuppression: false,  // Disable to preserve speech clarity
                autoGainControl: false,   // Disable to prevent volume fluctuations
                latency: 0.01,           // Request low latency
                volume: 1.0              // Maximum volume
            },
            video: false,
        });
        
        console.log('🎤 Microphone access granted, setting up audio processing...');

        // Setup audio processing with mic-specific settings
        console.log('🎤 Creating audio context with sample rate:', MIC_SAMPLE_RATE);
        micAudioContext = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
        
        console.log('🎤 Creating media stream source...');
        const micSource = micAudioContext.createMediaStreamSource(micStream);
        
        console.log('🎤 Creating script processor with buffer size:', MIC_BUFFER_SIZE);
        micAudioProcessor = micAudioContext.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);

        // Clear any existing buffers from previous sessions
        micAudioBuffer = [];
        micSendBuffer = []; // Buffer to accumulate chunks before sending
        const samplesPerChunk = MIC_SAMPLE_RATE * MIC_CHUNK_DURATION;
        const SEND_BUFFER_DURATION = 2.0; // Accumulate 2.0 seconds of audio before sending
        const chunksPerSend = Math.ceil(SEND_BUFFER_DURATION / MIC_CHUNK_DURATION);
        let chunkCount = 0;
        let lastSendTime = Date.now();
        const SEND_TIMEOUT = 3000; // Send after 3 seconds even if buffer not full

        micAudioProcessor.onaudioprocess = e => {
            const inputData = e.inputBuffer.getChannelData(0);
            
            // Apply gain boost to amplify microphone signal
            const gainBoost = 3.0; // 3x amplification
            const amplifiedData = new Float32Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                amplifiedData[i] = Math.max(-1.0, Math.min(1.0, inputData[i] * gainBoost));
            }
            
            // Debug: Log first few audio processing events
            if (micAudioBuffer.length < 10000) { // Only log for first ~10 seconds
                console.log('🎤 Audio data received, length:', amplifiedData.length, 'first sample:', amplifiedData[0]);
            }
            
            micAudioBuffer.push(...amplifiedData);

            // Process audio in chunks
            while (micAudioBuffer.length >= samplesPerChunk) {
                const chunk = micAudioBuffer.splice(0, samplesPerChunk);
                const float32Chunk = new Float32Array(chunk);
                
                // Always add chunk to send buffer to maintain continuity
                micSendBuffer.push(...chunk);
                chunkCount++;
                
                // Apply Voice Activity Detection for logging only
                const rmsValue = calculateRMS(float32Chunk);
                const silencePercentage = calculateSilencePercentage(float32Chunk);
                
                // Debug audio levels every 50 chunks (~4 seconds)
                if (chunkCount % 50 === 0) {
                    console.log(`🎤 Audio levels (Amplified) - RMS: ${rmsValue.toFixed(4)}, Silence: ${silencePercentage.toFixed(1)}%, Max: ${Math.max(...float32Chunk).toFixed(4)}, Min: ${Math.min(...float32Chunk).toFixed(4)}`);
                }
                
                // Send accumulated buffer when we have enough chunks or after timeout
                const now = Date.now();
                const shouldSendByTimeout = micSendBuffer.length > 0 && (now - lastSendTime) > SEND_TIMEOUT;
                
                if (chunkCount >= chunksPerSend || shouldSendByTimeout) {
                    if (micSendBuffer.length > 0) {
                        const float32SendChunk = new Float32Array(micSendBuffer);
                        
                        // Use smart audio router for automatic speaker detection
                        if (audioRouter) {
                            const wasProcessed = audioRouter.processAudioChunk(float32SendChunk, 'interviewee');
                            if (wasProcessed) {
                                process.stdout.write('M'); // Microphone audio sent
                            } else {
                                process.stdout.write('m'); // Microphone audio detected but not sent
                            }
                        } else {
                            process.stdout.write('R'); // Router not available
                            // Fallback to original logic if router not available
                            // Convert to WAV format for better compatibility
                            const wavBuffer = createWavBuffer(float32SendChunk, MIC_SAMPLE_RATE);
                            const base64Data = arrayBufferToBase64(wavBuffer);
                            
                            console.log(`🎤 Sending microphone audio: ${float32SendChunk.length} samples, ${(float32SendChunk.length / MIC_SAMPLE_RATE).toFixed(2)}s duration`);
                            
                            ipcRenderer.invoke('send-audio-content', {
                                data: base64Data,
                                mimeType: 'audio/wav',
                                source: 'interviewee'
                            }).catch(error => {
                                console.warn('Microphone audio send failed:', error.message);
                            });
                        }
                        
                        // Reset buffers and timer
                        micSendBuffer = [];
                        chunkCount = 0;
                        lastSendTime = now;
                    }
                }
            }
        };

        console.log('🎤 Setting up audio processor event handler...');
        
        console.log('🎤 Connecting audio nodes...');
        micSource.connect(micAudioProcessor);
        micAudioProcessor.connect(micAudioContext.destination);

        isMicrophoneCaptureActive = true;
        console.log('🎤 Microphone capture started successfully!');
        console.log('🎤 Audio context state:', micAudioContext.state);
        console.log('🎤 Stream active:', micStream.active);
        console.log('🎤 Stream tracks:', micStream.getTracks().map(track => ({ kind: track.kind, enabled: track.enabled, readyState: track.readyState })));
        
        return { success: true };
    } catch (error) {
        console.error('Error starting microphone capture:', error);
        return { success: false, error: error.message };
    }
}

// New function to stop microphone capture
async function stopMicrophoneCapture() {
    try {
        if (micAudioProcessor) {
            micAudioProcessor.disconnect();
            micAudioProcessor = null;
        }

        if (micAudioContext) {
            await micAudioContext.close();
            micAudioContext = null;
        }

        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
            micStream = null;
        }

        // Clear audio buffers to prevent accumulation
        micAudioBuffer = [];
        micSendBuffer = [];

        isMicrophoneCaptureActive = false;
        console.log('Microphone capture stopped and buffers cleared');
        
        return { success: true };
    } catch (error) {
        console.error('Error stopping microphone capture:', error);
        return { success: false, error: error.message };
    }
}

function setupWindowsLoopbackProcessing() {
    // Setup audio processing for Windows loopback audio with buffering like microphone
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    let sendBuffer = []; // Buffer to accumulate chunks before sending
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;
    const SEND_BUFFER_DURATION = 2.0; // Match microphone buffering
    const chunksPerSend = Math.ceil(SEND_BUFFER_DURATION / AUDIO_CHUNK_DURATION);
    let chunkCount = 0;
    let lastSendTime = Date.now();
    const SEND_TIMEOUT = 3000; // Match microphone timeout

    audioProcessor.onaudioprocess = e => {
            const inputData = e.inputBuffer.getChannelData(0);
            audioBuffer.push(...inputData);

            // Process audio in chunks with buffering
            while (audioBuffer.length >= samplesPerChunk) {
                const chunk = audioBuffer.splice(0, samplesPerChunk);
                
                // Add chunk to send buffer to maintain continuity
                sendBuffer.push(...chunk);
                chunkCount++;
                
                // Send accumulated buffer when we have enough chunks or after timeout
                const now = Date.now();
                const shouldSendByTimeout = sendBuffer.length > 0 && (now - lastSendTime) > SEND_TIMEOUT;
                
                if (chunkCount >= chunksPerSend || shouldSendByTimeout) {
                    if (sendBuffer.length > 0) {
                        const float32SendChunk = new Float32Array(sendBuffer);
                        
                        // Use smart audio router for automatic speaker detection
                        if (audioRouter) {
                            const wasProcessed = audioRouter.processAudioChunk(float32SendChunk, 'interviewer');
                            if (wasProcessed) {
                                process.stdout.write('S'); // Speaker audio sent
                            }
                        } else {
                            // Fallback to original logic if router not available
                            const pcmData16 = convertFloat32ToInt16(float32SendChunk);
                            const base64Data = arrayBufferToBase64(pcmData16.buffer);
                            
                            ipcRenderer.invoke('send-audio-content', {
                                data: base64Data,
                                mimeType: 'audio/pcm;rate=24000',
                                source: 'interviewer'
                            }).catch(error => {
                                console.warn('Audio send failed:', error.message);
                            });
                        }
                        
                        // Reset buffers and timer
                        sendBuffer = [];
                        chunkCount = 0;
                        lastSendTime = now;
                    }
                }
            }
        };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

async function captureScreenshot(imageQuality = 'medium', isManual = false) {
    console.log(`Capturing ${isManual ? 'manual' : 'automated'} screenshot...`);
    if (!mediaStream) return;

    // Check rate limiting for automated screenshots only
    if (!isManual && tokenTracker.shouldThrottle()) {
        console.log('⚠️ Automated screenshot skipped due to rate limiting');
        return;
    }

    // Lazy init of video element
    if (!hiddenVideo) {
        hiddenVideo = document.createElement('video');
        hiddenVideo.srcObject = mediaStream;
        hiddenVideo.muted = true;
        hiddenVideo.playsInline = true;
        await hiddenVideo.play();

        await new Promise(resolve => {
            if (hiddenVideo.readyState >= 2) return resolve();
            hiddenVideo.onloadedmetadata = () => resolve();
        });

        // Lazy init of canvas based on video dimensions
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        offscreenContext = offscreenCanvas.getContext('2d');
    }

    // Check if video is ready
    if (hiddenVideo.readyState < 2) {
        console.warn('Video not ready yet, skipping screenshot');
        return;
    }

    offscreenContext.drawImage(hiddenVideo, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

    // Check if image was drawn properly by sampling a pixel
    const imageData = offscreenContext.getImageData(0, 0, 1, 1);
    const isBlank = imageData.data.every((value, index) => {
        // Check if all pixels are black (0,0,0) or transparent
        return index === 3 ? true : value === 0;
    });

    if (isBlank) {
        console.warn('Screenshot appears to be blank/black');
    }

    let qualityValue;
    switch (imageQuality) {
        case 'high':
            qualityValue = 0.9;
            break;
        case 'medium':
            qualityValue = 0.7;
            break;
        case 'low':
            qualityValue = 0.5;
            break;
        default:
            qualityValue = 0.7; // Default to medium
    }

    offscreenCanvas.toBlob(
        async blob => {
            if (!blob) {
                console.error('Failed to create blob from canvas');
                return;
            }

            const reader = new FileReader();
            reader.onloadend = async () => {
                const base64data = reader.result.split(',')[1];

                // Validate base64 data
                if (!base64data || base64data.length < 100) {
                    console.error('Invalid base64 data generated');
                    return;
                }

                const result = await ipcRenderer.invoke('send-image-content', {
                    data: base64data,
                });

                if (result.success) {
                    // Track image tokens after successful send
                    const imageTokens = tokenTracker.calculateImageTokens(offscreenCanvas.width, offscreenCanvas.height);
                    tokenTracker.addTokens(imageTokens, 'image');
                    console.log(`📊 Image sent successfully - ${imageTokens} tokens used (${offscreenCanvas.width}x${offscreenCanvas.height})`);
                } else {
                    console.error('Failed to send image:', result.error);
                }
            };
            reader.readAsDataURL(blob);
        },
        'image/jpeg',
        qualityValue
    );
}

async function captureManualScreenshot(imageQuality = null) {
    console.log('Manual screenshot triggered - using combined context processing');
    
    try {
        const result = await ipcRenderer.invoke('process-context-with-screenshot');
        if (result.success) {
            console.log('Combined screenshot + context processing completed successfully');
        } else {
            console.error('Failed to process context with screenshot:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error in combined screenshot + context processing:', error);
        return { success: false, error: error.message };
    }
}

async function captureScreenshotForContext(imageQuality = null) {
    console.log('Screenshot for context triggered');
    const quality = imageQuality || currentImageQuality;
    await captureScreenshot(quality, true); // Pass true for isManual
}

// Expose functions to global scope for external access
window.captureManualScreenshot = captureManualScreenshot;

async function stopCapture() {
    console.log('Stopping capture...');

    // Clear screenshot interval
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }

    // Stop microphone capture if active
    if (isMicrophoneCaptureActive) {
        await stopMicrophoneCapture();
    }

    // Stop audio processing
    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    if (audioContext) {
        await audioContext.close();
        audioContext = null;
    }

    // Stop media stream
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // Stop macOS audio capture if running
    if (isMacOS) {
        ipcRenderer.invoke('stop-macos-audio').catch(err => {
            console.error('Error stopping macOS audio:', err);
        });
    }

    // Reset audio router
    if (audioRouter) {
        console.log('🎯 Resetting smart audio router');
        audioRouter = null;
    }

    // Clean up hidden elements
    if (hiddenVideo) {
        hiddenVideo.pause();
        hiddenVideo.srcObject = null;
        hiddenVideo = null;
    }
    offscreenCanvas = null;
    offscreenContext = null;

    console.log('Capture stopped');
}

// Send text message to Gemini
async function sendTextMessage(text) {
    if (!text || text.trim().length === 0) {
        console.warn('Cannot send empty text message');
        return { success: false, error: 'Empty message' };
    }

    try {
        const result = await ipcRenderer.invoke('send-text-message', text);
        if (result.success) {
            console.log('Text message sent successfully');
        } else {
            console.error('Failed to send text message:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending text message:', error);
        return { success: false, error: error.message };
    }
}

// Conversation storage functions using IndexedDB
let conversationDB = null;

async function initConversationStorage() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('ConversationHistory', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            conversationDB = request.result;
            resolve(conversationDB);
        };

        request.onupgradeneeded = event => {
            const db = event.target.result;

            // Create sessions store
            if (!db.objectStoreNames.contains('sessions')) {
                const sessionStore = db.createObjectStore('sessions', { keyPath: 'sessionId' });
                sessionStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

async function saveConversationSession(sessionId, conversationHistory) {
    if (!conversationDB) {
        await initConversationStorage();
    }

    const transaction = conversationDB.transaction(['sessions'], 'readwrite');
    const store = transaction.objectStore('sessions');

    const sessionData = {
        sessionId: sessionId,
        timestamp: parseInt(sessionId),
        conversationHistory: conversationHistory,
        lastUpdated: Date.now(),
    };

    return new Promise((resolve, reject) => {
        const request = store.put(sessionData);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function getConversationSession(sessionId) {
    if (!conversationDB) {
        await initConversationStorage();
    }

    const transaction = conversationDB.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');

    return new Promise((resolve, reject) => {
        const request = store.get(sessionId);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function getAllConversationSessions() {
    if (!conversationDB) {
        await initConversationStorage();
    }

    const transaction = conversationDB.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    const index = store.index('timestamp');

    return new Promise((resolve, reject) => {
        const request = index.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            // Sort by timestamp descending (newest first)
            const sessions = request.result.sort((a, b) => b.timestamp - a.timestamp);
            resolve(sessions);
        };
    });
}

// Listen for conversation data from main process
ipcRenderer.on('save-conversation-turn', async (event, data) => {
    try {
        await saveConversationSession(data.sessionId, data.fullHistory);
        console.log('Conversation session saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving conversation session:', error);
    }
});

// Initialize conversation storage when renderer loads
initConversationStorage().catch(console.error);

// Handle shortcuts based on current view
function handleShortcut(shortcutKey) {
    console.log('Handling shortcut:', shortcutKey);

    // Get current view from the app
    const currentView = window.cheddar.getCurrentView ? window.cheddar.getCurrentView() : null;
    console.log('Current view:', currentView);

    if (shortcutKey === 'ctrl+enter' || shortcutKey === 'cmd+enter') {
        if (currentView === 'main') {
            // Trigger the start session from main view
            console.log('Triggering start session from main view');

            // First try to get the app component and call handleStart directly
            const appElement = document.querySelector('cheating-daddy-app');
            if (appElement && typeof appElement.handleStart === 'function') {
                appElement.handleStart();
            } else {
                // Fallback: simulate click on the start button
                const mainView = document.querySelector('main-view');
                if (mainView) {
                    const startButton = mainView.shadowRoot?.querySelector('.start-button');
                    if (startButton && !startButton.classList.contains('initializing')) {
                        startButton.click();
                    } else {
                        console.warn('Start button not available or initializing');
                    }
                } else {
                    console.warn('Could not find main-view element');
                }
            }
        } else {
            // In other views, take manual screenshot
            console.log('Taking manual screenshot from current view');
            captureManualScreenshot();
        }
    }
}

// Expose microphone functions to global window object
window.startMicrophoneCapture = startMicrophoneCapture;
window.stopMicrophoneCapture = stopMicrophoneCapture;

window.cheddar = {
    initializeGemini,
    startCapture,
    stopCapture,
    sendTextMessage,
    handleShortcut,
    captureScreenshotForContext,
    // Microphone functions
    startMicrophoneCapture,
    stopMicrophoneCapture,
    // Conversation history functions
    getAllConversationSessions,
    getConversationSession,
    initConversationStorage,
    // Content protection function
    getContentProtection: () => {
        const contentProtection = localStorage.getItem('contentProtection');
        return contentProtection !== null ? contentProtection === 'true' : true;
    },
    // isLinux: isLinux, // Commented out - Windows only deployment
    isMacOS: isMacOS,
    e: cheddarElement,
    // Audio router functions for debugging and monitoring
    getAudioRouter: () => audioRouter,
    getAudioStats: () => audioRouter ? audioRouter.getActivityStats() : null,
};

// Add IPC listener for screenshot capture
ipcRenderer.on('capture-screenshot-for-context', () => {
    captureScreenshotForContext();
});

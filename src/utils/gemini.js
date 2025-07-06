const { GoogleGenAI } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio, AUDIO_SOURCES, analyzeAudioBufferWithSource, detectVoiceActivity } = require('../audioUtils');
const { getSystemPrompt, getProfileOptions } = require('./prompts');
const { getMultipleNotionContents } = require('./notion');

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let isInitializingSession = false;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';

// Dual audio management
let micAudioProcessor = null;
let micAudioContext = null;
let transcriptionHistory = [];
let lastAudioSource = AUDIO_SOURCES.INTERVIEWER; // Track the last audio source
let audioSourceQueue = []; // Queue to track audio chunks and their sources sent
let lastTranscriptionTime = Date.now();
const TRANSCRIPTION_WINDOW_MS = 4 * 60 * 1000; // 4 minutes
const CONTEXT_SEND_INTERVAL_MS = 30 * 1000; // Send context every 30 seconds
let expectingManualResponse = false; // Track if we're expecting a response from Process button

// Reconnection tracking variables
let reconnectionAttempts = 0;
let maxReconnectionAttempts = 3;
let reconnectionDelay = 2000; // 2 seconds between attempts
let lastSessionParams = null;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Conversation management functions
function initializeNewSession() {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    console.log('New conversation session started:', currentSessionId);
}

// Enhanced transcription management with source tagging
function addTranscription(text, source, timestamp = Date.now()) {
    const transcriptionEntry = {
        timestamp,
        text: text.trim(),
        source, // 'interviewer' or 'interviewee'
        sessionId: currentSessionId
    };
    
    transcriptionHistory.push(transcriptionEntry);
    
    // Clean old transcriptions (keep only last 4 minutes)
    const cutoffTime = timestamp - TRANSCRIPTION_WINDOW_MS;
    transcriptionHistory = transcriptionHistory.filter(entry => entry.timestamp > cutoffTime);
    
    const speakerLabel = source === AUDIO_SOURCES.INTERVIEWER ? 'Interviewer says' : 'Interviewee says';
    console.log(`${speakerLabel}: ${text.substring(0, 50)}...`);
    
    // Send to renderer for display with proper labeling
    sendToRenderer('transcription-update', {
        entry: transcriptionEntry,
        history: transcriptionHistory,
        label: speakerLabel
    });
}

function getRecentTranscriptions(windowMs = TRANSCRIPTION_WINDOW_MS) {
    const cutoffTime = Date.now() - windowMs;
    return transcriptionHistory
        .filter(entry => entry.timestamp > cutoffTime)
        .sort((a, b) => a.timestamp - b.timestamp);
}

function determineTranscriptionSource() {
    // Look at recent audio chunks (last 5 seconds) to determine most likely source
    const recentTime = Date.now() - 5000; // 5 seconds ago
    const recentChunks = audioSourceQueue.filter(chunk => chunk.timestamp > recentTime);
    
    if (recentChunks.length === 0) {
        // Fallback to lastAudioSource if no recent chunks
        return lastAudioSource;
    }
    
    // Count chunks by source
    const sourceCounts = {
        [AUDIO_SOURCES.INTERVIEWER]: 0,
        [AUDIO_SOURCES.INTERVIEWEE]: 0
    };
    
    recentChunks.forEach(chunk => {
        sourceCounts[chunk.source]++;
    });
    
    // Return the source with more recent activity, or the most recent if tied
    if (sourceCounts[AUDIO_SOURCES.INTERVIEWEE] > sourceCounts[AUDIO_SOURCES.INTERVIEWER]) {
        return AUDIO_SOURCES.INTERVIEWEE;
    } else if (sourceCounts[AUDIO_SOURCES.INTERVIEWER] > sourceCounts[AUDIO_SOURCES.INTERVIEWEE]) {
        return AUDIO_SOURCES.INTERVIEWER;
    } else {
        // If tied, use the most recent chunk's source
        return recentChunks[recentChunks.length - 1]?.source || lastAudioSource;
    }
}

function formatTranscriptionsForContext() {
    const recent = getRecentTranscriptions();
    if (recent.length === 0) return '';
    
    const formatted = recent.map(entry => {
        const timeAgo = Math.floor((Date.now() - entry.timestamp) / 1000);
        const speaker = entry.source === AUDIO_SOURCES.INTERVIEWER ? 'Interviewer' : 'Interviewee';
        return `[${timeAgo}s ago] ${speaker}: ${entry.text}`;
    }).join('\n');
    
    return `Recent conversation context (last 4 minutes):\n${formatted}\n\nPlease provide a concise answer to the most recent question from the interviewer.`;
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function sendReconnectionContext() {
    if (!global.geminiSessionRef?.current || conversationHistory.length === 0) {
        return;
    }

    try {
        // Gather all transcriptions from the conversation history
        const transcriptions = conversationHistory
            .map(turn => turn.transcription)
            .filter(transcription => transcription && transcription.trim().length > 0);

        if (transcriptions.length === 0) {
            return;
        }

        // Create the context message
        const contextMessage = `Till now all these questions were asked in the interview, answer the last one please:\n\n${transcriptions.join('\n')}`;

        console.log('Sending reconnection context with', transcriptions.length, 'previous questions');

        // Send the context message to the new session
        await global.geminiSessionRef.current.sendRealtimeInput({
            text: contextMessage,
        });
    } catch (error) {
        console.error('Error sending reconnection context:', error);
    }
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

async function attemptReconnection() {
    if (!lastSessionParams || reconnectionAttempts >= maxReconnectionAttempts) {
        console.log('Max reconnection attempts reached or no session params stored');
        sendToRenderer('update-status', 'Session closed');
        return false;
    }

    reconnectionAttempts++;
    console.log(`Attempting reconnection ${reconnectionAttempts}/${maxReconnectionAttempts}...`);

    // Wait before attempting reconnection
    await new Promise(resolve => setTimeout(resolve, reconnectionDelay));

    try {
        const session = await initializeGeminiSession(
            lastSessionParams.apiKey,
            lastSessionParams.customPrompt,
            lastSessionParams.profile,
            lastSessionParams.language,
            true // isReconnection flag
        );

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;
            reconnectionAttempts = 0; // Reset counter on successful reconnection
            console.log('Live session reconnected');

            // Send context message with previous transcriptions
            await sendReconnectionContext();

            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectionAttempts} failed:`, error);
    }

    // If this attempt failed, try again
    if (reconnectionAttempts < maxReconnectionAttempts) {
        return attemptReconnection();
    } else {
        console.log('All reconnection attempts failed');
        sendToRenderer('update-status', 'Session closed');
        return false;
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnection = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    sendToRenderer('session-initializing', true);

    // Store session parameters for reconnection (only if not already reconnecting)
    if (!isReconnection) {
        lastSessionParams = {
            apiKey,
            customPrompt,
            profile,
            language,
        };
        reconnectionAttempts = 0; // Reset counter for new session
    }

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
    });

    // Get enabled tools first to determine Google Search status
    const enabledTools = await getEnabledTools();
    const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

    // Get Notion context if available
    const getNotionContext = async () => {
        try {
            // Get Notion settings from renderer process via IPC
            const { BrowserWindow } = require('electron');
            const windows = BrowserWindow.getAllWindows();
            
            if (windows.length === 0) {
                return '';
            }
            
            const mainWindow = windows[0];
            
            // Get Notion settings from renderer's localStorage
            const notionSettings = await mainWindow.webContents.executeJavaScript(`
                (function() {
                    try {
                        const notionApiKey = localStorage.getItem('notionApiKey');
                        const notionPagesJson = localStorage.getItem('notionPages');
                        
                        if (!notionApiKey || !notionPagesJson) {
                            return null;
                        }
                        
                        const notionPages = JSON.parse(notionPagesJson);
                        if (!notionPages || notionPages.length === 0) {
                            return null;
                        }
                        
                        return { apiKey: notionApiKey, pages: notionPages };
                    } catch (error) {
                        console.error('Error getting Notion settings:', error);
                        return null;
                    }
                })()
            `);
            
            if (!notionSettings) {
                return '';
            }
            
            // Use the notion module to get content
            const { getMultipleNotionContents } = require('./notion');
            const content = await getMultipleNotionContents(notionSettings.apiKey, notionSettings.pages);
            
            return content || '';
        } catch (error) {
            console.error('Error getting Notion context:', error);
            return '';
        }
    };

    const notionContext = await getNotionContext();

    const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled, notionContext);

    // Initialize new conversation session (only if not reconnecting)
    if (!isReconnection) {
        initializeNewSession();
    }

    try {
        const session = await client.live.connect({
            model: 'gemini-live-2.5-flash-preview',
            callbacks: {
                onopen: function () {
                    sendToRenderer('update-status', 'Live session connected');
                },
                onmessage: function (message) {
                    //console.log('----------------', message);

                    // Handle transcription input with source detection - just build context, don't respond
                    if (message.serverContent?.inputTranscription?.text) {
                        const transcriptionText = message.serverContent.inputTranscription.text;
                        
                        // Use improved source detection instead of lastAudioSource
                        const source = determineTranscriptionSource();
                        addTranscription(transcriptionText, source);
                        
                        // Just log transcription, don't trigger automatic responses
                        const speakerLabel = source === AUDIO_SOURCES.INTERVIEWER ? 'Interviewer says' : 'Interviewee says';
                        console.log(`${speakerLabel}: ${transcriptionText}`);
                    }

                    // Handle AI model response (only when manually triggered via Process button)
                    if (message.serverContent?.modelTurn?.parts && expectingManualResponse) {
                        for (const part of message.serverContent.modelTurn.parts) {
                            if (part.text) {
                                messageBuffer += part.text;
                                // Render the chunked response to the renderer
                                sendToRenderer('update-response', messageBuffer);
                            }
                        }
                    }

                    if (message.serverContent?.generationComplete && expectingManualResponse) {
                        // Clear the response timeout since we got a response
                        if (global.currentResponseTimeout) {
                            clearTimeout(global.currentResponseTimeout);
                            global.currentResponseTimeout = null;
                        }
                        
                        // Only save conversation turn if we have a manual response (from Process button)
                        if (messageBuffer) {
                            // Get recent transcriptions to save as context
                            const recentTranscriptions = getRecentTranscriptions(60000); // Last minute
                            const transcriptionContext = recentTranscriptions.map(entry => {
                                const speaker = entry.source === AUDIO_SOURCES.INTERVIEWER ? 'Interviewer' : 'Interviewee';
                                return `${speaker}: ${entry.text}`;
                            }).join('\n');
                            
                            saveConversationTurn(transcriptionContext, messageBuffer);
                        }

                        messageBuffer = '';
                        expectingManualResponse = false; // Reset the flag
                        sendToRenderer('response-complete');
                    }

                    if (message.serverContent?.turnComplete) {
                        sendToRenderer('update-status', 'Listening...');
                    }
                },
                onerror: function (e) {
                    console.debug('Error:', e.message);

                    // Check if the error is related to invalid API key
                    const isApiKeyError =
                        e.message &&
                        (e.message.includes('API key not valid') ||
                            e.message.includes('invalid API key') ||
                            e.message.includes('authentication failed') ||
                            e.message.includes('unauthorized'));

                    if (isApiKeyError) {
                        console.log('Error due to invalid API key - stopping reconnection attempts');
                        lastSessionParams = null; // Clear session params to prevent reconnection
                        reconnectionAttempts = maxReconnectionAttempts; // Stop further attempts
                        sendToRenderer('update-status', 'Error: Invalid API key');
                        return;
                    }

                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    console.debug('Session closed:', e.reason);
                    // Check if the session closed due to invalid API key
                    const isApiKeyError =
                        e.reason &&
                        (e.reason.includes('API key not valid') ||
                            e.reason.includes('invalid API key') ||
                            e.reason.includes('authentication failed') ||
                            e.reason.includes('unauthorized'));

                    if (isApiKeyError) {
                        console.log('Session closed due to invalid API key - stopping reconnection attempts');
                        lastSessionParams = null; // Clear session params to prevent reconnection
                        reconnectionAttempts = maxReconnectionAttempts; // Stop further attempts
                        sendToRenderer('update-status', 'Session closed: Invalid API key');
                        return;
                    }

                    // Attempt automatic reconnection for server-side closures
                    if (lastSessionParams && reconnectionAttempts < maxReconnectionAttempts) {
                        console.log('Attempting automatic reconnection...');
                        attemptReconnection();
                    } else {
                        sendToRenderer('update-status', 'Session closed');
                    }
                },
            },
            config: {
                responseModalities: ['TEXT'],
                tools: enabledTools,
                inputAudioTranscription: {
                    model: 'models/gemini-2.5-flash',
                    enableAutomaticPunctuation: true,
                    enableWordTimeOffsets: false, // Disabled to reduce processing time
                    enableWordConfidence: false, // Disabled to reduce processing time
                    maxAlternatives: 1, // Reduced from 3 to 1 for faster response
                    profanityFilter: false,
                    enableSpeakerDiarization: false,
                    languageCode: language
                },
                contextWindowCompression: { slidingWindow: {} },
                speechConfig: { languageCode: language },
                systemInstruction: {
                    parts: [{ text: systemPrompt }],
                },
            },
        });

        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return null;
    }
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    systemAudioProc = spawn(systemAudioPath, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.08; // 80ms chunks for speaker audio (balanced)
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            const base64Data = monoChunk.toString('base64');
            sendAudioToGemini(base64Data, geminiSessionRef, AUDIO_SOURCES.INTERVIEWER);

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed interviewer audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio', Date.now(), AUDIO_SOURCES.INTERVIEWER);
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef, source = AUDIO_SOURCES.INTERVIEWER) {
    if (!geminiSessionRef.current) return;

    try {
        // Track the audio source in queue for transcription labeling
        const audioChunk = {
            timestamp: Date.now(),
            source: source,
            size: base64Data.length
        };
        audioSourceQueue.push(audioChunk);
        
        // Keep queue size manageable (last 50 chunks)
        if (audioSourceQueue.length > 50) {
            audioSourceQueue.shift();
        }
        
        // Also update lastAudioSource as fallback
        lastAudioSource = source;
        
        const symbol = source === AUDIO_SOURCES.INTERVIEWER ? '.' : 'i';
        process.stdout.write(symbol);
        
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
        
        if (process.env.DEBUG_AUDIO) {
            const buffer = Buffer.from(base64Data, 'base64');
            saveDebugAudio(buffer, `audio_${source}`, Date.now(), source);
        }
    } catch (error) {
        console.error(`Error sending ${source} audio to Gemini:`, error);
    }
}

// Start microphone capture for interviewee audio (placeholder - actual capture happens in renderer)
async function startMicrophoneCapture(geminiSessionRef) {
    console.log('Microphone capture will be handled by renderer process');
    // Microphone capture is handled entirely in the renderer process
    // This function exists for IPC compatibility
    return true;
}

// Stop microphone capture
function stopMicrophoneCapture() {
    if (micAudioProcessor) {
        console.log('Stopping microphone capture...');
        micAudioProcessor.disconnect();
        micAudioProcessor = null;
    }
    
    if (micAudioContext) {
        micAudioContext.close();
        micAudioContext = null;
    }
}

// Helper function to convert Float32Array to Int16Array
function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;
    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType, source }) => {
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            // Determine the audio source
            const audioSource = source === 'interviewee' ? AUDIO_SOURCES.INTERVIEWEE : AUDIO_SOURCES.INTERVIEWER;
            
            // Send audio with source tagging (data is already base64)
            await sendAudioToGemini(data, geminiSessionRef, audioSource);
            
            process.stdout.write(audioSource === AUDIO_SOURCES.INTERVIEWEE ? 'i' : '.');
            return { success: true };
        } catch (error) {
            console.error('Error sending audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, debug }) => {
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');
            await geminiSessionRef.current.sendRealtimeInput({
                media: { data: data, mimeType: 'image/jpeg' },
            });

            return { success: true };
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return { success: false, error: 'Invalid text message' };
            }

            console.log('Sending text message:', text);
            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-microphone-audio', async event => {
        try {
            const success = await startMicrophoneCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting microphone capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-microphone-audio', async event => {
        try {
            stopMicrophoneCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping microphone capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();
            stopMicrophoneCapture();

            // Clear session params to prevent reconnection when user closes session
            lastSessionParams = null;

            // Clear transcription history
            transcriptionHistory = [];

            // Cleanup any pending resources and stop audio/video capture
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('process-all-context', async (event) => {
        if (!geminiSessionRef.current) {
            return { success: false, error: 'No active Gemini session' };
        }

        // Prevent multiple simultaneous requests
        if (expectingManualResponse) {
            console.log('Already waiting for a manual response, skipping request');
            return { success: false, error: 'Already processing a request' };
        }

        try {
            console.log('Processing all context manually...');
            
            // Get recent transcriptions (last 10 minutes for more context)
            const recentTranscriptions = getRecentTranscriptions(10 * 60 * 1000);
            
            // Build context with proper speaker labels
            let contextMessage = '';
            let wordCount = 0;
            const maxWords = 1000;
            
            if (recentTranscriptions.length > 0) {
                // Format transcriptions with proper labels
                const formattedTranscriptions = recentTranscriptions.map(entry => {
                    const timeAgo = Math.floor((Date.now() - entry.timestamp) / 1000);
                    const speaker = entry.source === AUDIO_SOURCES.INTERVIEWER ? 'Interviewer says' : 'Interviewee says';
                    return `[${timeAgo}s ago] ${speaker}: ${entry.text}`;
                });
                
                // Limit context to 1000-2000 words, prioritizing most recent
                let selectedTranscriptions = [];
                for (let i = formattedTranscriptions.length - 1; i >= 0; i--) {
                    const transcription = formattedTranscriptions[i];
                    const transcriptionWords = transcription.split(' ').length;
                    
                    if (wordCount + transcriptionWords <= maxWords) {
                        selectedTranscriptions.unshift(transcription);
                        wordCount += transcriptionWords;
                    } else {
                        break;
                    }
                }
                
                if (selectedTranscriptions.length > 0) {
                    contextMessage += `Recent conversation context (last ${Math.floor(wordCount)} words):\n${selectedTranscriptions.join('\n')}\n\n`;
                }
            }
            
            // Find the most recent question from interviewer
            const recentQuestions = recentTranscriptions
                .filter(entry => entry.source === AUDIO_SOURCES.INTERVIEWER)
                .slice(-3); // Last 3 interviewer statements
            
            if (recentQuestions.length > 0) {
                const lastQuestion = recentQuestions[recentQuestions.length - 1];
                contextMessage += `Most recent question to focus on: "${lastQuestion.text}"\n\n`;
            }
            
            if (contextMessage.trim().length === 0) {
                contextMessage = 'No recent conversation context available. Please analyze the current screen content and provide assistance based on what you can see.\n\n';
            }
            
            contextMessage += 'Based on the above conversation context and current screen capture analysis (if available), please provide a comprehensive and helpful response. Focus on answering the most recent question from the interviewer.';
            
            console.log(`Sending manual context processing request to Gemini (${wordCount} words)`);
            expectingManualResponse = true; // Set flag to process the upcoming response
            
            // Set a timeout to reset the flag if no response comes back
            const responseTimeout = setTimeout(() => {
                if (expectingManualResponse) {
                    console.warn('Timeout waiting for Gemini response, resetting expectingManualResponse flag');
                    expectingManualResponse = false;
                    sendToRenderer('update-status', 'Request timeout - ready for new requests');
                }
            }, 30000); // 30 second timeout
            
            // Store timeout ID to clear it if response comes back
            global.currentResponseTimeout = responseTimeout;
            
            await geminiSessionRef.current.sendRealtimeInput({ text: contextMessage });
            
            return { success: true, wordCount };
        } catch (error) {
            console.error('Error processing context:', error);
            expectingManualResponse = false; // Reset flag on error
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('process-context-with-screenshot', async (event) => {
        if (!geminiSessionRef.current) {
            return { success: false, error: 'No active Gemini session' };
        }

        // Prevent multiple simultaneous requests
        if (expectingManualResponse) {
            console.log('Already waiting for a manual response, skipping request');
            return { success: false, error: 'Already processing a request' };
        }

        try {
            console.log('Processing context with screenshot manually...');
            
            // First, trigger screenshot capture
            const screenshotResult = await new Promise((resolve) => {
                // Send message to renderer to capture screenshot
                sendToRenderer('capture-screenshot-for-context');
                
                // Wait a moment for screenshot to be captured and sent
                setTimeout(() => {
                    resolve({ success: true });
                }, 2000); // 2 second delay like in captureManualScreenshot
            });
            
            // Get recent transcriptions (last 10 minutes for more context)
            const recentTranscriptions = getRecentTranscriptions(10 * 60 * 1000);
            
            // Build context with proper speaker labels
            let contextMessage = '';
            let wordCount = 0;
            const maxWords = 1000;
            
            if (recentTranscriptions.length > 0) {
                // Format transcriptions with proper labels
                const formattedTranscriptions = recentTranscriptions.map(entry => {
                    const timeAgo = Math.floor((Date.now() - entry.timestamp) / 1000);
                    const speaker = entry.source === AUDIO_SOURCES.INTERVIEWER ? 'Interviewer says' : 'Interviewee says';
                    return `[${timeAgo}s ago] ${speaker}: ${entry.text}`;
                });
                
                // Limit context to 1000-2000 words, prioritizing most recent
                let selectedTranscriptions = [];
                for (let i = formattedTranscriptions.length - 1; i >= 0; i--) {
                    const transcription = formattedTranscriptions[i];
                    const transcriptionWords = transcription.split(' ').length;
                    
                    if (wordCount + transcriptionWords <= maxWords) {
                        selectedTranscriptions.unshift(transcription);
                        wordCount += transcriptionWords;
                    } else {
                        break;
                    }
                }
                
                if (selectedTranscriptions.length > 0) {
                    contextMessage += `Recent conversation context (last ${Math.floor(wordCount)} words):\n${selectedTranscriptions.join('\n')}\n\n`;
                }
            }
            
            // Find the most recent question from interviewer
            const recentQuestions = recentTranscriptions
                .filter(entry => entry.source === AUDIO_SOURCES.INTERVIEWER)
                .slice(-3); // Last 3 interviewer statements
            
            if (recentQuestions.length > 0) {
                const lastQuestion = recentQuestions[recentQuestions.length - 1];
                contextMessage += `Most recent question to focus on: "${lastQuestion.text}"\n\n`;
            }
            
            if (contextMessage.trim().length === 0) {
                contextMessage = 'No recent conversation context available. Please analyze the current screen content and provide assistance based on what you can see.\n\n';
            }
            
            // Add the predefined prompt from captureManualScreenshot
            contextMessage += `Help me on this page, give me the answer no bs, complete answer.
        So if its a code question, give me the approach in few bullet points, then the entire code. Also if theres anything else i need to know, tell me.
        If its a mcq question, give me the answer no bs, complete answer.
        
        Based on the above conversation context and current screen capture analysis, please provide a comprehensive and helpful response. Focus on answering the most recent question from the interviewer.`;
            
            console.log(`Sending combined screenshot + context processing request to Gemini (${wordCount} words)`);
            expectingManualResponse = true; // Set flag to process the upcoming response
            
            // Set a timeout to reset the flag if no response comes back
            const responseTimeout = setTimeout(() => {
                if (expectingManualResponse) {
                    console.warn('Timeout waiting for Gemini response, resetting expectingManualResponse flag');
                    expectingManualResponse = false;
                    sendToRenderer('update-status', 'Request timeout - ready for new requests');
                }
            }, 30000); // 30 second timeout
            
            // Store timeout ID to clear it if response comes back
            global.currentResponseTimeout = responseTimeout;
            
            await geminiSessionRef.current.sendRealtimeInput({ text: contextMessage });
            
            return { success: true, wordCount };
        } catch (error) {
            console.error('Error processing context with screenshot:', error);
            expectingManualResponse = false; // Reset flag on error
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('reset-context-and-reinitialize', async (event) => {
        try {
            console.log('Reset context and reinitialize session requested');
            
            // Stop any existing audio capture
            stopMacOSAudioCapture();
            stopMicrophoneCapture();
            
            // Close existing session if it exists
            if (geminiSessionRef.current) {
                try {
                    await geminiSessionRef.current.close();
                } catch (closeError) {
                    console.warn('Error closing existing session:', closeError);
                }
                geminiSessionRef.current = null;
            }
            
            // Initialize a new conversation session (reset context)
            initializeNewSession();
            
            // Clear transcription history and buffers
            transcriptionHistory = [];
            audioSourceQueue = []; // Clear audio source queue
            messageBuffer = '';
            currentTranscription = '';
            expectingManualResponse = false; // Reset manual response flag
            
            // Reinitialize Gemini session with updated system prompt if we have stored params
            if (lastSessionParams) {
                console.log('Reinitializing Gemini session with updated system prompt...');
                const session = await initializeGeminiSession(
                    lastSessionParams.apiKey,
                    lastSessionParams.customPrompt,
                    lastSessionParams.profile,
                    lastSessionParams.language,
                    false // Not a reconnection, force new session
                );
                if (session) {
                    geminiSessionRef.current = session;
                    sendToRenderer('update-status', 'Session reinitialized with updated settings');
                } else {
                    sendToRenderer('update-status', 'Context reset - Ready to reinitialize');
                }
            } else {
                sendToRenderer('update-status', 'Context reset - Ready to reinitialize');
            }
            
            sendToRenderer('context-reset-complete');
            
            console.log('Context reset and reinitialization completed successfully');
             return { success: true, sessionId: currentSessionId };
         } catch (error) {
             console.error('Error resetting context:', error);
             return { success: false, error: error.message };
         }
     });

    // Add handler to get recent transcriptions
    ipcMain.handle('get-recent-transcriptions', async (event) => {
        try {
            const recent = getRecentTranscriptions();
            return { success: true, transcriptions: recent };
        } catch (error) {
            console.error('Error getting recent transcriptions:', error);
            return { success: false, error: error.message };
        }
    });

    // Periodic context updates removed - now using manual Process button only
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    sendReconnectionContext,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    setupGeminiIpcHandlers,
    attemptReconnection,
    // New dual audio functions
    addTranscription,
    getRecentTranscriptions,
    formatTranscriptionsForContext,
    startMicrophoneCapture,
    stopMicrophoneCapture,
    convertFloat32ToInt16,
};

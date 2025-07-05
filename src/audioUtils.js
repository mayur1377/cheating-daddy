const fs = require('fs');
const path = require('path');

// Audio source types for tagging
const AUDIO_SOURCES = {
    INTERVIEWER: 'interviewer', // Speaker/system audio
    INTERVIEWEE: 'interviewee'  // Microphone audio
};

// VAD (Voice Activity Detection) configuration - optimized for microphone audio
const VAD_CONFIG = {
    SILENCE_THRESHOLD: 0.001,    // More sensitive for microphone audio
    MIN_SPEECH_DURATION: 0.05,   // Shorter duration for faster response
    MAX_SILENCE_DURATION: 0.3,   // Shorter silence duration for continuous capture
    SAMPLE_RATE: 24000
};

// Separate VAD config for speaker audio (same as microphone now)
const SPEAKER_VAD_CONFIG = {
    SILENCE_THRESHOLD: 0.005,
    MIN_SPEECH_DURATION: 0.1,
    MAX_SILENCE_DURATION: 0.5,
    SAMPLE_RATE: 24000
};

// Convert raw PCM to WAV format for easier playback and verification
function pcmToWav(pcmBuffer, outputPath, sampleRate = 24000, channels = 1, bitDepth = 16) {
    const byteRate = sampleRate * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = pcmBuffer.length;

    // Create WAV header
    const header = Buffer.alloc(44);

    // "RIFF" chunk descriptor
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4); // File size - 8
    header.write('WAVE', 8);

    // "fmt " sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    header.writeUInt16LE(channels, 22); // NumChannels
    header.writeUInt32LE(sampleRate, 24); // SampleRate
    header.writeUInt32LE(byteRate, 28); // ByteRate
    header.writeUInt16LE(blockAlign, 32); // BlockAlign
    header.writeUInt16LE(bitDepth, 34); // BitsPerSample

    // "data" sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40); // Subchunk2Size

    // Combine header and PCM data
    const wavBuffer = Buffer.concat([header, pcmBuffer]);

    // Write to file
    fs.writeFileSync(outputPath, wavBuffer);

    return outputPath;
}

// Analyze audio buffer for debugging
function analyzeAudioBuffer(buffer, label = 'Audio') {
    const int16Array = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);

    let minValue = 32767;
    let maxValue = -32768;
    let avgValue = 0;
    let rmsValue = 0;
    let silentSamples = 0;

    for (let i = 0; i < int16Array.length; i++) {
        const sample = int16Array[i];
        minValue = Math.min(minValue, sample);
        maxValue = Math.max(maxValue, sample);
        avgValue += sample;
        rmsValue += sample * sample;

        if (Math.abs(sample) < 100) {
            silentSamples++;
        }
    }

    avgValue /= int16Array.length;
    rmsValue = Math.sqrt(rmsValue / int16Array.length);

    const silencePercentage = (silentSamples / int16Array.length) * 100;

    console.log(`${label} Analysis:`);
    console.log(`  Samples: ${int16Array.length}`);
    console.log(`  Min: ${minValue}, Max: ${maxValue}`);
    console.log(`  Average: ${avgValue.toFixed(2)}`);
    console.log(`  RMS: ${rmsValue.toFixed(2)}`);
    console.log(`  Silence: ${silencePercentage.toFixed(1)}%`);
    console.log(`  Dynamic Range: ${20 * Math.log10(maxValue / (rmsValue || 1))} dB`);

    return {
        minValue,
        maxValue,
        avgValue,
        rmsValue,
        silencePercentage,
        sampleCount: int16Array.length,
    };
}

// Voice Activity Detection for microphone audio
function detectVoiceActivity(buffer, source = AUDIO_SOURCES.INTERVIEWEE) {
    const analysis = analyzeAudioBuffer(buffer, `VAD-${source}`);
    
    // Use appropriate VAD config based on source
    const vadConfig = source === AUDIO_SOURCES.INTERVIEWER ? SPEAKER_VAD_CONFIG : VAD_CONFIG;
    
    // For interviewer audio (system), use speaker-optimized settings
    if (source === AUDIO_SOURCES.INTERVIEWER) {
        return {
            hasVoice: analysis.rmsValue > vadConfig.SILENCE_THRESHOLD,
            confidence: analysis.rmsValue > vadConfig.SILENCE_THRESHOLD ? 0.9 : 0.1,
            source: source,
            analysis: analysis
        };
    }
    
    // For interviewee audio (microphone), use more sensitive thresholds
    const hasVoice = analysis.rmsValue > vadConfig.SILENCE_THRESHOLD && 
                     analysis.silencePercentage < 85; // More permissive for microphone audio
    
    const confidence = hasVoice ? 
        Math.min(0.95, analysis.rmsValue / VAD_CONFIG.SILENCE_THRESHOLD) : 
        Math.max(0.05, 1 - (analysis.silencePercentage / 100));
    
    return {
        hasVoice: hasVoice,
        confidence: confidence,
        source: source,
        analysis: analysis
    };
}

// Enhanced audio buffer analysis with source tagging
function analyzeAudioBufferWithSource(buffer, source, label = 'Audio') {
    const analysis = analyzeAudioBuffer(buffer, `${label}-${source}`);
    const vadResult = detectVoiceActivity(buffer, source);
    
    return {
        ...analysis,
        source: source,
        vad: vadResult,
        timestamp: Date.now()
    };
}

// Save audio buffer with metadata for debugging
function saveDebugAudio(buffer, type, timestamp = Date.now(), source = null) {
    const homeDir = require('os').homedir();
    const debugDir = path.join(homeDir, 'cheddar', 'debug');

    if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
    }

    const pcmPath = path.join(debugDir, `${type}_${timestamp}.pcm`);
    const wavPath = path.join(debugDir, `${type}_${timestamp}.wav`);
    const metaPath = path.join(debugDir, `${type}_${timestamp}.json`);

    // Save raw PCM
    fs.writeFileSync(pcmPath, buffer);

    // Convert to WAV for easy playback
    pcmToWav(buffer, wavPath);

    // Analyze and save metadata with source information
    const analysis = source ? 
        analyzeAudioBufferWithSource(buffer, source, type) : 
        analyzeAudioBuffer(buffer, type);
    
    fs.writeFileSync(
        metaPath,
        JSON.stringify(
            {
                timestamp,
                type,
                source: source || 'unknown',
                bufferSize: buffer.length,
                analysis,
                format: {
                    sampleRate: 24000,
                    channels: 1,
                    bitDepth: 16,
                },
            },
            null,
            2
        )
    );

    console.log(`Debug audio saved: ${wavPath}`);

    return { pcmPath, wavPath, metaPath };
}

module.exports = {
    pcmToWav,
    analyzeAudioBuffer,
    analyzeAudioBufferWithSource,
    detectVoiceActivity,
    saveDebugAudio,
    AUDIO_SOURCES,
    VAD_CONFIG,
    SPEAKER_VAD_CONFIG,
};

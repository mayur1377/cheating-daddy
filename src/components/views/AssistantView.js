import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class AssistantView extends LitElement {
    static styles = css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        * {
            font-family: 'Inter', sans-serif;
            cursor: default;
        }

        .response-container {
            height: calc(100% - 60px);
            overflow-y: auto;
            border-radius: 10px;
            font-size: var(--response-font-size, 18px);
            line-height: 1.6;
            background: var(--main-content-background);
            padding: 16px;
            scroll-behavior: smooth;
        }

        /* Markdown styling */
        .response-container h1,
        .response-container h2,
        .response-container h3,
        .response-container h4,
        .response-container h5,
        .response-container h6 {
            margin: 1.2em 0 0.6em 0;
            color: var(--text-color);
            font-weight: 600;
        }

        .response-container h1 {
            font-size: 1.8em;
        }
        .response-container h2 {
            font-size: 1.5em;
        }
        .response-container h3 {
            font-size: 1.3em;
        }
        .response-container h4 {
            font-size: 1.1em;
        }
        .response-container h5 {
            font-size: 1em;
        }
        .response-container h6 {
            font-size: 0.9em;
        }

        .response-container p {
            margin: 0.8em 0;
            color: var(--text-color);
        }

        .response-container ul,
        .response-container ol {
            margin: 0.8em 0;
            padding-left: 2em;
            color: var(--text-color);
        }

        .response-container li {
            margin: 0.4em 0;
        }

        .response-container blockquote {
            margin: 1em 0;
            padding: 0.5em 1em;
            border-left: 4px solid var(--focus-border-color);
            background: rgba(0, 122, 255, 0.1);
            font-style: italic;
        }

        .response-container code {
            /* Allow highlight.js theme to apply all styling */
            font-family: "Consolas", 'Courier New', monospace;
            font-size: 0.9724em; /* Increased by 30% from 0.748em */
            line-height: 0.28; /* Reduced by 50% from 0.56 */
        }

        .response-container pre {
            background: #1e1e1e; /* A dark background for code blocks */
            border: 1px solid var(--button-border);
            border-radius: 6px;
            padding: 1em;
            /* Remove overflow-x: auto to prevent horizontal scrollbar */
            margin: 1em 0;
            white-space: pre-wrap; /* Wrap long lines */
            word-wrap: break-word; /* Break words if necessary */
        }

        .response-container pre code {
            /* Allow highlight.js theme to apply all styling */
            background: transparent; /* Ensure pre background shows through */
            font-family: "Consolas", 'Courier New', monospace;
            font-size: 0.9724em; /* Increased by 30% from 0.748em */
            line-height: 0.28; /* Reduced by 50% from 0.56 */
        }

        /* Force highlight.js colors with !important if necessary */
        .response-container pre code .hljs-comment,
        .response-container pre code .hljs-quote {
            color: #5c6370 !important; /* Atom One Dark comment color */
        }
        .response-container pre code .hljs-keyword,
        .response-container pre code .hljs-selector-tag,
        .response-container pre code .hljs-subst {
            color: #c678dd !important; /* Atom One Dark keyword color */
        }
        .response-container pre code .hljs-number,
        .response-container pre code .hljs-literal,
        .response-container pre code .hljs-variable,
        .response-container pre code .hljs-template-variable,
        .response-container pre code .hljs-tag .hljs-attr {
            color: #d19a66 !important; /* Atom One Dark number/variable color */
        }
        .response-container pre code .hljs-string,
        .response-container pre code .hljs-doctag {
            color: #98c379 !important; /* Atom One Dark string color */
        }
        .response-container pre code .hljs-title,
        .response-container pre code .hljs-section,
        .response-container pre code .hljs-name,
        .response-container pre code .hljs-selector-id,
        .response-container pre code .hljs-selector-class {
            color: #e6c07b !important; /* Atom One Dark title/name color */
        }
        .response-container pre code .hljs-type,
        .response-container pre code .hljs-built_in,
        .response-container pre code .hljs-builtin-name,
        .response-container pre code .hljs-attr,
        .response-container pre code .hljs-selector-attr,
        .response-container pre code .hljs-selector-pseudo,
        .response-container pre code .hljs-addition,
        .response-container pre code .hljs-variable.language {
            color: #e06c75 !important; /* Atom One Dark type/attribute color */
        }
        .response-container pre code .hljs-class .hljs-title,
        .response-container pre code .hljs-function .hljs-title {
            color: #61afef !important; /* Atom One Dark class/function title color */
        }
        .response-container pre code .hljs-symbol,
        .response-container pre code .hljs-bullet,
        .response-container pre code .hljs-link,
        .response-container pre code .hljs-deletion {
            color: #e06c75 !important; /* Atom One Dark symbol/link color */
        }
        .response-container pre code .hljs-meta {
            color: #abb2bf !important; /* Atom One Dark meta color */
        }
        .response-container pre code .hljs-emphasis {
            font-style: italic !important;
        }
        .response-container pre code .hljs-strong {
            font-weight: bold !important;
        }
        .response-container pre code .hljs {
            color: #abb2bf !important; /* Default text color for Atom One Dark */
        }


        .response-container a {
            color: var(--link-color);
            text-decoration: none;
        }

        .response-container a:hover {
            text-decoration: underline;
        }

        .response-container strong,
        .response-container b {
            font-weight: 600;
            color: var(--text-color);
        }

        .response-container em,
        .response-container i {
            font-style: italic;
        }

        .response-container hr {
            border: none;
            border-top: 1px solid var(--border-color);
            margin: 2em 0;
        }

        .response-container table {
            border-collapse: collapse;
            width: 100%;
            margin: 1em 0;
        }

        .response-container th,
        .response-container td {
            border: 1px solid var(--border-color);
            padding: 0.5em;
            text-align: left;
        }

        .response-container th {
            background: var(--input-background);
            font-weight: 600;
        }

        .response-container::-webkit-scrollbar {
            width: 8px;
        }

        .response-container::-webkit-scrollbar-track {
            background: var(--scrollbar-track);
            border-radius: 4px;
        }

        .response-container::-webkit-scrollbar-thumb {
            background: var(--scrollbar-thumb);
            border-radius: 4px;
        }

        .response-container::-webkit-scrollbar-thumb:hover {
            background: var(--scrollbar-thumb-hover);
        }

        .text-input-container {
            display: flex;
            gap: 10px;
            margin-top: 10px;
            align-items: center;
        }

        .text-input-container input {
            flex: 1;
            background: var(--input-background);
            color: var(--text-color);
            border: 1px solid var(--button-border);
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 14px;
        }

        .text-input-container input:focus {
            outline: none;
            border-color: var(--focus-border-color);
            box-shadow: 0 0 0 3px var(--focus-box-shadow);
            background: var(--input-focus-background);
        }

        .text-input-container input::placeholder {
            color: var(--placeholder-color);
        }

        .text-input-container button {
            background: transparent;
            color: var(--start-button-background);
            border: none;
            padding: 0;
            border-radius: 100px;
        }

        .text-input-container button:hover {
            background: var(--text-input-button-hover);
        }

        .nav-button {
            background: transparent;
            color: white;
            border: none;
            padding: 4px;
            border-radius: 50%;
            font-size: 12px;
            display: flex;
            align-items: center;
            width: 36px;
            height: 36px;
            justify-content: center;
        }

        .nav-button:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .nav-button:disabled {
            opacity: 0.3;
        }

        .nav-button svg {
            stroke: white !important;
        }

        .response-counter {
            font-size: 12px;
            color: var(--description-color);
            white-space: nowrap;
            min-width: 60px;
            text-align: center;
        }

        .mic-button {
            background: transparent;
            color: var(--description-color);
            border: none;
            padding: 8px;
            border-radius: 50%;
            font-size: 12px;
            display: flex;
            align-items: center;
            width: 36px;
            height: 36px;
            justify-content: center;
            transition: all 0.2s ease;
        }

        .mic-button:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .mic-button.active {
            color: #ff4444;
            background: rgba(255, 68, 68, 0.1);
        }

        .mic-button.active:hover {
            background: rgba(255, 68, 68, 0.2);
        }

        .mic-button svg {
            width: 18px;
            height: 18px;
        }

        .process-button {
            background: var(--start-button-background);
            color: white;
            border: none;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s ease;
            white-space: nowrap;
        }

        .process-button:hover {
            background: var(--start-button-hover);
            transform: translateY(-1px);
        }

        .process-button:active {
            transform: translateY(0);
        }

        .process-button svg {
            width: 14px;
            height: 14px;
        }


    `;

    static properties = {
        responses: { type: Array },
        currentResponseIndex: { type: Number },
        selectedProfile: { type: String },
        onSendText: { type: Function },
        isMicrophoneActive: { type: Boolean },
    };

    constructor() {
        super();
        this.responses = [];
        this.currentResponseIndex = -1;
        this.selectedProfile = 'interview';
        this.onSendText = () => {};
        this.isMicrophoneActive = false;
    }

    getProfileNames() {
        return {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
        };
    }

    getCurrentResponse() {
        const profileNames = this.getProfileNames();
        return this.responses.length > 0 && this.currentResponseIndex >= 0
            ? this.responses[this.currentResponseIndex].text
            : `Hey, Im listening to your ${profileNames[this.selectedProfile] || 'session'}?`;
    }

    renderMarkdown(content) {
        // Check if marked is available
        if (typeof window !== 'undefined' && window.marked && window.hljs) {
            try {
                // Configure marked for better security and formatting
                window.marked.setOptions({
                    breaks: true,
                    gfm: true,
                    sanitize: false, // We trust the AI responses
                    highlight: function (code, lang) {
                        let language = lang;
                        if (!window.hljs.getLanguage(lang)) {
                            language = 'java'; // Default to Java if language not recognized
                        }
                        console.log(`Highlighting code: lang=${lang}, effective_lang=${language}`);
                        const highlightedCode = window.hljs.highlight(code, { language }).value;
                        return highlightedCode;
                    },
                });
                const rendered = window.marked.parse(content);
                console.log('Markdown rendered successfully');
                console.log('Rendered response (after marked parse):', rendered);
                return rendered;
            } catch (error) {
                console.warn('Error parsing markdown:', error);
                return content; // Fallback to plain text
            }
        }
        console.log('Marked or Highlight.js not available, using plain text');
        return content; // Fallback if marked or highlight.js is not available
    }

    getResponseCounter() {
        return this.responses.length > 0 ? `${this.currentResponseIndex + 1}/${this.responses.length}` : '';
    }

    navigateToPreviousResponse() {
        if (this.currentResponseIndex > 0) {
            this.currentResponseIndex--;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    navigateToNextResponse() {
        if (this.currentResponseIndex < this.responses.length - 1) {
            this.currentResponseIndex++;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    scrollResponseUp() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3; // Scroll 30% of container height
            container.scrollTop = Math.max(0, container.scrollTop - scrollAmount);
        }
    }

    scrollResponseDown() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3; // Scroll 30% of container height
            container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + scrollAmount);
        }
    }

    loadFontSize() {
        const fontSize = localStorage.getItem('fontSize');
        if (fontSize !== null) {
            const fontSizeValue = parseInt(fontSize, 10) || 20;
            const root = document.documentElement;
            root.style.setProperty('--response-font-size', `${fontSizeValue}px`);
        }
    }

    connectedCallback() {
        super.connectedCallback();

        // Load and apply font size
        this.loadFontSize();

        // Dynamically load highlight.js theme into shadow DOM
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '../../assets/styles/atom-one-dark.min.css'; // Path relative to AssistantView.js
        this.shadowRoot.appendChild(link);

        // Set up IPC listeners for keyboard shortcuts
        if (window.require) {
            const { ipcRenderer } = window.require('electron');

            this.handlePreviousResponse = () => {
                console.log('Received navigate-previous-response message');
                this.navigateToPreviousResponse();
            };

            this.handleNextResponse = () => {
                console.log('Received navigate-next-response message');
                this.navigateToNextResponse();
            };

            this.handleScrollUp = () => {
                console.log('Received scroll-response-up message');
                this.scrollResponseUp();
            };

            this.handleScrollDown = () => {
                console.log('Received scroll-response-down message');
                this.scrollResponseDown();
            };

            ipcRenderer.on('navigate-previous-response', this.handlePreviousResponse);
            ipcRenderer.on('navigate-next-response', this.handleNextResponse);
            ipcRenderer.on('scroll-response-up', this.handleScrollUp);
            ipcRenderer.on('scroll-response-down', this.handleScrollDown);
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();

        // Clean up IPC listeners
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            if (this.handlePreviousResponse) {
                ipcRenderer.removeListener('navigate-previous-response', this.handlePreviousResponse);
            }
            if (this.handleNextResponse) {
                ipcRenderer.removeListener('navigate-next-response', this.handleNextResponse);
            }
            if (this.handleScrollUp) {
                ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
            }
            if (this.handleScrollDown) {
                ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
            }
        }
    }

    async handleSendText() {
        const textInput = this.shadowRoot.querySelector('#textInput');
        if (textInput && textInput.value.trim()) {
            const message = textInput.value.trim();
            textInput.value = ''; // Clear input
            await this.onSendText(message);
        }
    }

    handleTextKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSendText();
        }
    }

    async handleMicrophoneToggle() {
        if (this.isMicrophoneActive) {
            // Stop microphone capture
            if (window.stopMicrophoneCapture) {
                const result = await window.stopMicrophoneCapture();
                if (result && result.success) {
                    this.isMicrophoneActive = false;
                } else {
                    console.error('Failed to stop microphone:', result?.error || 'Unknown error');
                    return; // Don't dispatch event if failed
                }
            }
        } else {
            // Start microphone capture
            if (window.startMicrophoneCapture) {
                try {
                    const result = await window.startMicrophoneCapture();
                    if (result && result.success) {
                        this.isMicrophoneActive = true;
                    } else {
                        console.error('Failed to start microphone:', result?.error || 'Unknown error');
                        alert('Failed to start microphone. Please check your microphone permissions and try again.');
                        return; // Don't dispatch event if failed
                    }
                } catch (error) {
                    console.error('Failed to start microphone capture:', error);
                    alert('Failed to start microphone. Please try again.');
                    return; // Don't dispatch event if failed
                }
            }
        }
        
        // Dispatch event to parent component
        this.dispatchEvent(
            new CustomEvent('microphone-state-changed', {
                detail: { isActive: this.isMicrophoneActive },
                bubbles: true
            })
        );
        
        this.requestUpdate();
    }

    async handleProcessContext() {
        console.log('Processing all context manually...');
        
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            try {
                const result = await ipcRenderer.invoke('process-all-context');
                if (result.success) {
                    console.log('Context processed successfully');
                } else {
                    console.error('Failed to process context:', result.error);
                }
            } catch (error) {
                console.error('Error processing context:', error);
            }
        }
    }

    scrollToBottom() {
        setTimeout(() => {
            const container = this.shadowRoot.querySelector('.response-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 0);
    }



    firstUpdated() {
        super.firstUpdated();
        this.updateResponseContent();
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        if (changedProperties.has('responses') || changedProperties.has('currentResponseIndex')) {
            this.updateResponseContent();
        }
    }

    updateResponseContent() {
        console.log('updateResponseContent called');
        const container = this.shadowRoot.querySelector('#responseContainer');
        if (container) {
            const currentResponse = this.getCurrentResponse();
            console.log('Current response:', currentResponse);
            const renderedResponse = this.renderMarkdown(currentResponse);
            console.log('Rendered response:', renderedResponse);
            container.innerHTML = renderedResponse;
            // Manually highlight the code blocks after rendering
            if (window.hljs) {
                window.hljs.highlightAll();
            }
        } else {
            console.log('Response container not found');
        }
    }

    render() {
        const currentResponse = this.getCurrentResponse();
        const responseCounter = this.getResponseCounter();

        return html`
            <div class="response-container" id="responseContainer"></div>

            <div class="text-input-container">
                <button class="nav-button" @click=${this.navigateToPreviousResponse} ?disabled=${this.currentResponseIndex <= 0}>
                    <?xml version="1.0" encoding="UTF-8"?><svg
                        width="24px"
                        height="24px"
                        stroke-width="1.7"
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        color="#ffffff"
                    >
                        <path d="M15 6L9 12L15 18" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                </button>

                ${this.responses.length > 0 ? html` <span class="response-counter">${responseCounter}</span> ` : ''}

                <button class="mic-button ${this.isMicrophoneActive ? 'active' : ''}" @click=${this.handleMicrophoneToggle} title="${this.isMicrophoneActive ? 'Stop microphone' : 'Start microphone'}">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 1C10.34 1 9 2.34 9 4V12C9 13.66 10.34 15 12 15C13.66 15 15 13.66 15 12V4C15 2.34 13.66 1 12 1Z" fill="currentColor"/>
                        <path d="M19 10V12C19 16.42 15.42 20 11 20H13C17.42 20 21 16.42 21 12V10H19Z" fill="currentColor"/>
                        <path d="M5 10V12C5 16.42 8.58 20 13 20H11C6.58 20 3 16.42 3 12V10H5Z" fill="currentColor"/>
                        <path d="M12 22V20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        <path d="M8 22H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                </button>

                <button class="process-button" @click=${this.handleProcessContext} title="Process all context and get AI response">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M13 2L3 14H12L11 22L21 10H12L13 2Z" fill="currentColor"/>
                    </svg>
                    Process
                </button>

                <input type="text" id="textInput" placeholder="Type a message to the AI..." @keydown=${this.handleTextKeydown} />

                <button class="nav-button" @click=${this.navigateToNextResponse} ?disabled=${this.currentResponseIndex >= this.responses.length - 1}>
                    <?xml version="1.0" encoding="UTF-8"?><svg
                        width="24px"
                        height="24px"
                        stroke-width="1.7"
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        color="#ffffff"
                    >
                        <path d="M9 6L15 12L9 18" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                </button>
            </div>
        `;
    }
}

customElements.define('assistant-view', AssistantView);

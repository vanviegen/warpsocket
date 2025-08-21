class ChatClient {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.currentRoom = null;
        this.currentAlias = null;
        
        this.initializeEventListeners();
        this.connect();
    }

    initializeEventListeners() {
        // Join room form
        const joinForm = document.getElementById('join-room-form');
        joinForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.joinRoom();
        });

        // Message form
        const messageForm = document.getElementById('message-form');
        messageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.sendMessage();
        });

        // Leave room button
        const leaveButton = document.getElementById('leave-room');
        leaveButton.addEventListener('click', () => {
            this.leaveRoom();
        });

        // Auto-focus message input when in chat
        const messageInput = document.getElementById('message-input');
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.hostname}:8080`;
        
        console.log('Attempting to connect to:', wsUrl);
        this.updateStatus('Connecting...', 'connecting');
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.isConnected = true;
                this.updateStatus('Connected', 'connected');
                console.log('WebSocket connected');
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            };

            this.ws.onclose = (event) => {
                this.isConnected = false;
                this.updateStatus('Disconnected', 'disconnected');
                console.log('WebSocket disconnected, code:', event.code, 'reason:', event.reason);
                
                // Try to reconnect after 3 seconds
                setTimeout(() => {
                    if (!this.isConnected) {
                        this.connect();
                    }
                }, 3000);
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.updateStatus('Connection Error', 'disconnected');
            };
        } catch (error) {
            console.error('Failed to create WebSocket connection:', error);
            this.updateStatus('Connection Failed', 'disconnected');
        }
    }

    updateStatus(message, className) {
        const statusElement = document.getElementById('connection-status');
        const statusContainer = document.getElementById('status');
        
        statusElement.textContent = message;
        statusContainer.className = `status ${className}`;
    }

    joinRoom() {
        const aliasInput = document.getElementById('alias');
        const roomInput = document.getElementById('room');
        
        const alias = aliasInput.value.trim();
        const room = roomInput.value.trim();
        
        if (!alias || !room) {
            alert('Please enter both alias and room name');
            return;
        }

        if (!this.isConnected) {
            alert('Not connected to server. Please wait...');
            return;
        }

        this.currentAlias = alias;
        this.currentRoom = room;

        // Send join message
        this.sendWebSocketMessage({
            type: 'join',
            alias: alias,
            room: room
        });
    }

    leaveRoom() {
        this.currentRoom = null;
        this.currentAlias = null;
        
        // Show join form, hide chat interface
        document.getElementById('join-form').style.display = 'block';
        document.getElementById('chat-interface').style.display = 'none';
        
        // Clear messages
        document.getElementById('messages').innerHTML = '';
        
        // Clear form inputs
        document.getElementById('alias').value = '';
        document.getElementById('room').value = '';
    }

    sendMessage() {
        const messageInput = document.getElementById('message-input');
        const message = messageInput.value.trim();
        
        if (!message) {
            return;
        }

        if (!this.isConnected) {
            this.addSystemMessage('Not connected to server');
            return;
        }

        if (!this.currentRoom) {
            this.addSystemMessage('You are not in a room');
            return;
        }

        // Send message
        this.sendWebSocketMessage({
            type: 'message',
            message: message
        });

        // Clear input
        messageInput.value = '';
    }

    sendWebSocketMessage(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            console.error('WebSocket is not open');
        }
    }

    handleMessage(message) {
        console.log('Received message:', message);
        
        switch (message.type) {
            case 'joined':
                this.onJoinedRoom(message);
                break;
            case 'chat-message':
                this.addChatMessage(message);
                break;
            case 'user-joined':
                this.addUserJoinedMessage(message);
                break;
            case 'user-left':
                this.addUserLeftMessage(message);
                break;
            case 'error':
                this.addErrorMessage(message.message);
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    }

    onJoinedRoom(message) {
        // Hide join form, show chat interface
        document.getElementById('join-form').style.display = 'none';
        document.getElementById('chat-interface').style.display = 'flex';
        
        // Update UI with room and user info
        document.getElementById('room-title').textContent = `Room: ${message.room}`;
        document.getElementById('user-alias').textContent = message.alias;
        
        // Focus message input
        document.getElementById('message-input').focus();
        
        // Add welcome message
        this.addSystemMessage(`Welcome to room "${message.room}"! You are ${message.alias}.`);
    }

    addChatMessage(message) {
        const messageElement = this.createMessageElement('chat-message');
        
        const header = document.createElement('div');
        header.className = 'message-header';
        
        const author = document.createElement('span');
        author.className = 'message-author';
        author.textContent = message.alias;
        
        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = this.formatTime(message.timestamp);
        
        header.appendChild(author);
        header.appendChild(time);
        
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = message.message;
        
        messageElement.appendChild(header);
        messageElement.appendChild(content);
        
        this.appendMessage(messageElement);
    }

    addUserJoinedMessage(message) {
        const messageElement = this.createMessageElement('user-joined');
        messageElement.innerHTML = `
            <strong>${message.alias}</strong> joined the room
            <span class="message-time">${this.formatTime(message.timestamp)}</span>
        `;
        this.appendMessage(messageElement);
    }

    addUserLeftMessage(message) {
        const messageElement = this.createMessageElement('user-left');
        messageElement.innerHTML = `
            <strong>${message.alias}</strong> left the room
            <span class="message-time">${this.formatTime(message.timestamp)}</span>
        `;
        this.appendMessage(messageElement);
    }

    addSystemMessage(text) {
        const messageElement = this.createMessageElement('system-message');
        messageElement.innerHTML = `
            ${text}
            <span class="message-time">${this.formatTime(Date.now())}</span>
        `;
        this.appendMessage(messageElement);
    }

    addErrorMessage(text) {
        const messageElement = this.createMessageElement('error');
        messageElement.innerHTML = `
            <strong>Error:</strong> ${text}
            <span class="message-time">${this.formatTime(Date.now())}</span>
        `;
        this.appendMessage(messageElement);
    }

    createMessageElement(className) {
        const messageElement = document.createElement('div');
        messageElement.className = `message ${className}`;
        return messageElement;
    }

    appendMessage(messageElement) {
        const messagesContainer = document.getElementById('messages');
        messagesContainer.appendChild(messageElement);
        
        // Scroll to bottom
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        // Limit number of messages to prevent memory issues
        const messages = messagesContainer.children;
        if (messages.length > 100) {
            messagesContainer.removeChild(messages[0]);
        }
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
    }
}

// Initialize the chat client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new ChatClient();
});

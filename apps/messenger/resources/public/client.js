(function () {
	const formMessenger = new Form();
	formMessenger.setTitle('Messenger');

	// Occupy 1/3 of screen width, 100% height, at right edge
	const updateMessengerLayout = () => {
		const screenWidth = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
		const screenHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
		const formWidth = Math.round(screenWidth / 2);

		// Account for top offset (menu) and bottom offset (taskbar)
		const topOffset = (typeof Form !== 'undefined' && Form.topOffset) ? Form.topOffset : 0;
		const bottomOffset = (typeof Form !== 'undefined' && Form.bottomOffset) ? Form.bottomOffset : 0;

		formMessenger.setWidth(formWidth);
		formMessenger.setHeight(screenHeight - topOffset - bottomOffset);
		formMessenger.setX(screenWidth - formWidth);
		formMessenger.setY(topOffset);
	};

	updateMessengerLayout();
	window.addEventListener('resize', updateMessengerLayout);

	formMessenger.displayMemory = '0';
	formMessenger.dotPressed = false;
	formMessenger.operationGiven = false;
	formMessenger.operation = null;
	formMessenger.value1 = '';
	formMessenger.value2 = '';
	formMessenger.isError = false;

	// Form data refresh function
	formMessenger.refresh = function () {
		callServerMethod('messenger', 'loadChats', {})
			.then(result => {
				if (result.error) {
					console.error('[Messenger] Error:', result.error);
					return;
				}

				// Clear chats area
				const chatsContainer = formMessenger.chatsContainer;
				if (chatsContainer) {
					chatsContainer.innerHTML = '';

					// Display chats in a column aligned to top
					if (result.chats && result.chats.length > 0) {
						result.chats.forEach(chat => {
							const chatDiv = document.createElement('div');
							chatDiv.style.padding = '8px';
							chatDiv.style.borderBottom = '1px solid #ccc';
							chatDiv.style.cursor = 'pointer';
							chatDiv.style.textAlign = 'left';
							chatDiv.style.verticalAlign = 'top';
							chatDiv.textContent = chat.name;

							// Highlight on hover
							chatDiv.addEventListener('mouseenter', function () {
								this.style.backgroundColor = '#e0e0e0';
							});
							chatDiv.addEventListener('mouseleave', function () {
								this.style.backgroundColor = '';
							});

							// Click handler
							chatDiv.addEventListener('click', function () {
								console.log('[Messenger] Chat selected:', chat.name, 'ID:', chat.chatId);
								formMessenger.loadChatMessages(chat.chatId);
							}); chatsContainer.appendChild(chatDiv);
						});
					} else {
						chatsContainer.textContent = 'No chats';
						chatsContainer.style.padding = '8px';
						chatsContainer.style.color = '#888';
					}
				}
			})
			.catch(err => {
				console.error('[Messenger] Update error: ' + err.message);
			});
	};

	// Chat messages loading function
	formMessenger.loadChatMessages = function (chatId) {
		if (!chatId) return;

		const messagesContainer = this.messagesContainer;
		if (!messagesContainer) return;

		// Show loading indicator
		messagesContainer.innerHTML = '<div style="padding: 8px; color: #888;">Loading messages...</div>';

		callServerMethod('messenger', 'loadMessages', { chatId })
			.then(result => {
				if (result.error) {
					console.error('[Messenger] Error:', result.error);
					messagesContainer.innerHTML = '<div style="padding: 8px; color: red;">Error: ' + result.error + '</div>';
					return;
				}

				// Clear messages area
				messagesContainer.innerHTML = '';

				// Display messages
				if (result.messages && result.messages.length > 0) {
					result.messages.forEach(msg => {
						const msgDiv = document.createElement('div');
						msgDiv.style.marginBottom = '12px';
						msgDiv.style.padding = '8px';
						msgDiv.style.borderRadius = '4px';
						msgDiv.style.backgroundColor = '#f5f5f5';

						// Header: author and time
						const headerDiv = document.createElement('div');
						headerDiv.style.fontSize = '12px';
						headerDiv.style.color = '#666';
						headerDiv.style.marginBottom = '4px';
						const timestamp = new Date(msg.createdAt).toLocaleString('ru-RU');
						headerDiv.textContent = `${msg.authorName} • ${timestamp}`;
						msgDiv.appendChild(headerDiv);

						// Message text
						const contentDiv = document.createElement('div');
						contentDiv.style.fontSize = '14px';
						contentDiv.textContent = msg.content;
						msgDiv.appendChild(contentDiv);

						messagesContainer.appendChild(msgDiv);
					});

					// Scroll to last message
					messagesContainer.scrollTop = messagesContainer.scrollHeight;
				} else {
					messagesContainer.innerHTML = '<div style="padding: 8px; color: #888;">No messages</div>';
				}

				// Save current chatId and enable input
				this.currentChatId = chatId;
				if (this.messageInput) this.messageInput.disabled = false;
				if (this.sendButton) this.sendButton.disabled = false;

				// Connect SSE for auto-update
				this.connectSSE(chatId);
			})
			.catch(err => {
				console.error('[Messenger] Messages loading error:', err.message);
				messagesContainer.innerHTML = '<div style="padding: 8px; color: red;">Loading error</div>';
			});
	};

	// Message sending function
	formMessenger.sendMessage = function (content) {
		if (!this.currentChatId || !content) return;

		// Disable input during sending
		if (this.messageInput) this.messageInput.disabled = true;
		if (this.sendButton) this.sendButton.disabled = true;

		callServerMethod('messenger', 'sendMessage', { chatId: this.currentChatId, content })
			.then(result => {
				if (result.error) {
					console.error('[Messenger] Sending error:', result.error);
					showAlert('Error: ' + result.error);
					return;
				}

				if (result.success && result.message) {
					// Clear input field
					if (this.messageInput) this.messageInput.value = '';
					// Message will be added automatically via SSE
				}
			})
			.catch(err => {
				console.error('[Messenger] Message sending error:', err.message);
				showAlert('Sending error');
			})
			.finally(() => {
				// Enable input back
				if (this.messageInput) this.messageInput.disabled = false;
				if (this.sendButton) this.sendButton.disabled = false;
				if (this.messageInput) this.messageInput.focus();
			});
	};

	// Connect to SSE for auto-updating messages
	formMessenger.connectSSE = function (chatId) {
		// If already connected to this chat, do not reconnect
		if (this.eventSource && this.sseConnectedChatId === chatId) {
			console.log('[Messenger] SSE already connected to chat', chatId);
			return;
		}

		// Close previous connection
		if (this.eventSource) {
			console.log('[Messenger] Closing previous SSE connection');
			this.eventSource.close();
			this.eventSource = null;
			this.sseConnectedChatId = null;
		}

		if (!chatId) return;

		this.sseConnectedChatId = chatId;

		try {
			// Create EventSource (format: /app/messenger/subscribeToChat?chatId=...)
			const url = `/app/messenger/subscribeToChat?chatId=${chatId}`;
			this.eventSource = new EventSource(url);

			this.eventSource.onopen = () => {
				console.log('[Messenger] SSE connected to chat', chatId);
			};

			this.eventSource.onmessage = (event) => {
				console.log('[Messenger] SSE event received:', event.data);
				try {
					const data = JSON.parse(event.data);
					console.log('[Messenger] SSE parsed data:', data);

					if (data.type === 'connected') {
						console.log('[Messenger] SSE: connection confirmed');
					} else if (data.type === 'newMessage') {
						// New message from server
						console.log('[Messenger] New message via SSE:', data.message);
						this.addMessageToUI(data.message);
					}
				} catch (e) {
					console.error('[Messenger] SSE processing error:', e.message);
				}
			};

			this.eventSource.onerror = (error) => {
				console.error('[Messenger] SSE error:', error);
				if (this.eventSource.readyState === EventSource.CLOSED) {
					console.log('[Messenger] SSE connection closed');
				}
			};
		} catch (e) {
			console.error('[Messenger] SSE creation error:', e.message);
		}
	};

	// Adding message to UI
	formMessenger.addMessageToUI = function (msg) {
		const messagesContainer = this.messagesContainer;
		if (!messagesContainer) return;

		const msgDiv = document.createElement('div');
		msgDiv.style.marginBottom = '12px';
		msgDiv.style.padding = '8px';
		msgDiv.style.borderRadius = '4px';
		msgDiv.style.backgroundColor = '#f5f5f5';

		// Header
		const headerDiv = document.createElement('div');
		headerDiv.style.fontSize = '12px';
		headerDiv.style.color = '#666';
		headerDiv.style.marginBottom = '4px';
		const timestamp = new Date(msg.createdAt).toLocaleString('ru-RU');
		headerDiv.textContent = `${msg.authorName} • ${timestamp}`;
		msgDiv.appendChild(headerDiv);

		// Message text
		const contentDiv = document.createElement('div');
		contentDiv.style.fontSize = '14px';
		contentDiv.textContent = msg.content;
		msgDiv.appendChild(contentDiv);

		messagesContainer.appendChild(msgDiv);

		// Scroll to last message
		messagesContainer.scrollTop = messagesContainer.scrollHeight;
	};

	formMessenger.Draw = function (parent) {
		// Call base implementation
		Form.prototype.Draw.call(this, parent);

		// Create table with visible borders for debugging
		const contentArea = this.getContentArea();
		contentArea.style.height = '100%';
		contentArea.style.overflow = 'hidden'; // Disable scroll for entire window

		const table = document.createElement('table');
		contentArea.appendChild(table);
		table.style.width = '100%';
		table.style.height = '100%';
		table.style.borderCollapse = 'collapse';
		table.style.tableLayout = 'fixed';
		table.style.border = '1px solid black';

		// One row, two columns (left 1/4, right 3/4)
		const row = document.createElement('tr');
		row.style.height = '100%';
		table.appendChild(row);


		// Left column (1/4 width)
		const leftCell = document.createElement('td');
		leftCell.style.width = '25%';
		leftCell.style.border = '1px solid black';
		leftCell.style.verticalAlign = 'top';
		row.appendChild(leftCell);

		// Nested table in left column (2 rows)
		const leftTable = document.createElement('table');
		leftTable.style.width = '100%';
		leftTable.style.height = '100%';
		leftTable.style.borderCollapse = 'collapse';
		leftTable.style.tableLayout = 'fixed';
		leftTable.style.border = '1px solid black';
		leftCell.appendChild(leftTable);

		// Top cell (30px) - Label 'Chats'
		const leftRowTop = document.createElement('tr');
		leftTable.appendChild(leftRowTop);
		const leftCellTop = document.createElement('td');
		leftCellTop.style.border = '1px solid black';
		leftCellTop.style.height = '30px';
		leftRowTop.appendChild(leftCellTop);

		// Label 'Chats' (uses UI_classes.js)
		const chatsLabel = new Label(leftCellTop);
		chatsLabel.setText('Chats');
		chatsLabel.setParent(leftCellTop);
		chatsLabel.Draw(leftCellTop);
		chatsLabel.setFontSize('18px');
		chatsLabel.setFontWeight('bold');
		chatsLabel.Draw(leftCellTop);

		// Bottom cell (rest) - container for chats list
		const leftRowBottom = document.createElement('tr');
		leftTable.appendChild(leftRowBottom);
		const leftCellBottom = document.createElement('td');
		leftCellBottom.style.border = '1px solid black';
		leftCellBottom.style.overflow = 'auto';
		leftCellBottom.style.verticalAlign = 'top';
		leftRowBottom.appendChild(leftCellBottom);

		// Save reference to chats container
		this.chatsContainer = leftCellBottom;

		// Right column (3/4 width)
		const rightCell = document.createElement('td');
		rightCell.style.width = '75%';
		rightCell.style.border = '1px solid black';
		rightCell.style.verticalAlign = 'top';
		rightCell.style.height = '100%';
		rightCell.style.position = 'relative';
		row.appendChild(rightCell);

		// Use flexbox for right column with absolute positioning
		rightCell.style.padding = '0';
		const rightFlex = document.createElement('div');
		rightFlex.style.position = 'absolute';
		rightFlex.style.top = '0';
		rightFlex.style.left = '0';
		rightFlex.style.right = '0';
		rightFlex.style.bottom = '0';
		rightFlex.style.display = 'flex';
		rightFlex.style.flexDirection = 'column';
		rightCell.appendChild(rightFlex);

		// Top part (messages area) - stretches
		const messagesWrapper = document.createElement('div');
		messagesWrapper.style.flex = '1';
		messagesWrapper.style.overflow = 'auto';
		messagesWrapper.style.padding = '8px';
		messagesWrapper.style.borderBottom = '1px solid black';
		rightFlex.appendChild(messagesWrapper);

		// Save reference to messages area
		this.messagesContainer = messagesWrapper;

		// Bottom part (input area) - fixed height
		const rightCellBottom = document.createElement('div');
		rightCellBottom.style.height = '40px';
		rightCellBottom.style.flexShrink = '0';
		rightFlex.appendChild(rightCellBottom);

		// Save reference to input area
		this.inputContainer = rightCellBottom;

		// Create container for input elements with flex-layout
		const inputWrapper = document.createElement('div');
		inputWrapper.style.display = 'flex';
		inputWrapper.style.gap = '4px';
		inputWrapper.style.alignItems = 'center';
		inputWrapper.style.height = '100%';
		inputWrapper.style.padding = '4px';
		rightCellBottom.appendChild(inputWrapper);

		// TextBox for input
		const messageInput = document.createElement('input');
		messageInput.type = 'text';
		messageInput.placeholder = 'Enter message...';
		messageInput.style.flex = '1';
		messageInput.style.padding = '4px 8px';
		messageInput.style.border = '1px solid #ccc';
		messageInput.style.borderRadius = '4px';
		messageInput.style.fontSize = '14px';
		messageInput.disabled = true; // Disabled until chat selected
		inputWrapper.appendChild(messageInput);
		this.messageInput = messageInput;

		// Send button
		const sendButton = document.createElement('button');
		sendButton.type = 'button'; // Важно! Чтобы не было submit формы
		sendButton.textContent = 'Send';
		sendButton.style.padding = '4px 12px';
		sendButton.style.border = '1px solid #007bff';
		sendButton.style.backgroundColor = '#007bff';
		sendButton.style.color = 'white';
		sendButton.style.borderRadius = '4px';
		sendButton.style.cursor = 'pointer';
		sendButton.style.fontSize = '14px';
		sendButton.disabled = true; // Disabled until chat selected
		inputWrapper.appendChild(sendButton);
		this.sendButton = sendButton;

		// Message send handler
		const sendMessageHandler = () => {
			const content = messageInput.value.trim();
			if (content && this.currentChatId) {
				this.sendMessage(content);
			}
		};

		// Click on button
		sendButton.addEventListener('click', sendMessageHandler);

		// Enter on text field
		messageInput.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault(); // Prevent form submission
				sendMessageHandler();
			}
		});

		// For debug: color fill
		// rightCellTop.style.background = '#eef';
		// rightCellBottom.style.background = '#fee';
		// leftCell.style.background = '#efe';

		callServerMethod('messenger', 'onLoad', {})
			.then(result => {
				console.log('[Messenger] Data updated:', result);
				// Here we can update list of chats, messages, etc.
			})
			.catch(err => {
				console.error('[Messenger] Update error: ' + err.message);
			});

		// Initial load
		this.refresh();
	};

	formMessenger.Draw(document.body);
})();
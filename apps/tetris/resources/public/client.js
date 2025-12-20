(function () {
	// Flag for strict control of ArrowDown holding
	const formTetris = new Form();
	formTetris.setTitle('Tetris');
	formTetris.setX(600);
	formTetris.setY(200);
	formTetris.setWidth(470);
	formTetris.setHeight(600);
	formTetris.setAnchorToWindow('center');
	formTetris.setLockAspectRatio(true);

	// Properties and methods specific to Tetris game
	formTetris.gridWidth = 10;
	formTetris.gridHeight = 20;
	formTetris.grid = [];
	formTetris.linesPerLevel = 10;
	formTetris.playArea = null;
	formTetris.cellSize = 0;
	formTetris.currentFigure = null;
	formTetris.currentFigurePosition = { x: 0, y: 0 };
	formTetris.currentFigureRotation = 0;
	formTetris.score = 0;
	formTetris.level = 1;
	formTetris.linesCleared = 0;
	formTetris.gameInterval = null;
	formTetris.speedInterval = 0;
	formTetris.isGameOver = false;
	formTetris.nextFigure = null;
	formTetris.currentFigureElements = null;
	formTetris.currentFigureAdresses = null;
	formTetris.contentArea = null;
	formTetris.nextFigureArea = null;
	formTetris.nextFigureSize = 0;
	formTetris.scoreTextBox = null;
	formTetris.levelTextBox = null;
	formTetris.startButton = null;
	formTetris.pauseButton = null;
	formTetris.colorIndex = 0;
	formTetris.levelColor = null;
	formTetris.keysPressed = {};
	formTetris.moveInterval = null;
	formTetris.moveDelay = 100;
	formTetris.gameOverPanel = null;
	formTetris.gameOverTitle = null;
	formTetris.gameOverScore = null;
	formTetris.dropHoldCount = 0; // Counter for holding down key
	formTetris.allowDownPress = true;
	formTetris.cheatMode = false;

	// Pause flag
	formTetris.isPaused = false;

	// Color generator
	formTetris.colors = ['#00FFFF', '#0000FF', '#FFA500', '#FFFF00', '#00FF00', '#800080', '#FF0000'];

	formTetris.getNextColor = function () {
		const color = this.colors[this.colorIndex];
		this.colorIndex = (this.colorIndex + 1) % this.colors.length;
		return color;
	}

	formTetris.onKeyPressed = function (keyEvent) {
		if (this.isGameOver || this.isPaused) return;
		const key = keyEvent.key;
		if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(key)) {
			keyEvent.preventDefault();
			if (key === "ArrowDown" && !this.allowDownPress) return; // Ignore until released
			// Mark key as pressed
			if (!this.keysPressed[key]) {
				this.keysPressed[key] = true;
				this.processKeyActions();
				// Start interval for continuous movement
				if (!this.moveInterval) {
					this.moveInterval = setInterval(() => {
						this.processKeyActions();
					}, this.moveDelay);
				}
			}
		}
	}

	formTetris.onKeyReleased = function (keyEvent) {
		if (this.isPaused) return;
		const key = keyEvent.key;
		if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(key)) {
			this.keysPressed[key] = false;
			if (key === 'ArrowDown') {
				this.dropHoldCount = 0; // Reset drop hold counter
				this.allowDownPress = true; // Allow down press again
			}
			// Stop interval if all movement keys are released
			if (!this.keysPressed['ArrowLeft'] && !this.keysPressed['ArrowRight'] && !this.keysPressed['ArrowDown']) {
				if (this.moveInterval) {
					clearInterval(this.moveInterval);
					this.moveInterval = null;
				}
			}
		}
	}

	formTetris.processKeyActions = function () {
		if (this.isGameOver || this.isPaused) return;
		// Handle rotation
		if (this.keysPressed['ArrowUp']) {
			this.rotateFigure();
			this.keysPressed['ArrowUp'] = false; // Single rotation on press
		}
		// Handle left movement
		if (this.keysPressed['ArrowLeft']) {
			this.moveFigureLeft();
		}
		// Handle right movement
		if (this.keysPressed['ArrowRight']) {
			this.moveFigureRight();
		}
		// Handle down movement
		if (this.keysPressed['ArrowDown']) {
			// First two steps are normal
			if (this.dropHoldCount < 3) {
				this.moveFigureDown();
				this.dropHoldCount++;
			} else {
				// Fast (hard) drop: call moveFigureDown repeatedly
				// Continue while figure drops successfully. Exit when false returns (fixed).
				while (this.moveFigureDown()) { }
				this.dropHoldCount = 0;
			}
		}
	}

	formTetris.checkCollision = function (cellX, cellY) {
		if (cellX < 0 || cellX >= this.gridWidth || cellY < 0 || cellY >= this.gridHeight || this.grid[cellY][cellX].value !== 0) {
			return true;
		}
		return false;
	}

	formTetris.setNewFigure = function (newFigure) {
		const currentFigureShape = newFigure.shape[0];
		this.currentFigureAdresses = [];

		for (let i = 0; i < currentFigureShape.length; i++) {
			const cellX = this.currentFigurePosition.x + currentFigureShape[i][0];
			const cellY = this.currentFigurePosition.y + currentFigureShape[i][1];
			if (this.checkCollision(cellX, cellY)) {
				return false;
			}
			this.currentFigureAdresses.push({ x: cellX, y: cellY });
		}
		return true;
	}

	formTetris.showFigure = function (isNew = false) {

		if (isNew) {
			this.currentFigureElements = [];
		}
		for (let i = 0; i < this.currentFigureAdresses.length; i++) {
			const cellX = this.currentFigureAdresses[i].x;
			const cellY = this.currentFigureAdresses[i].y;
			const cell = this.grid[cellY][cellX];
			if (isNew) {
				const cellDiv = document.createElement('div');
				cellDiv.style.position = 'absolute';
				cellDiv.style.boxSizing = 'border-box';
				cellDiv.style.width = this.cellSize + 'px';
				cellDiv.style.height = this.cellSize + 'px';
				cellDiv.style.left = cell.left + 'px';
				cellDiv.style.top = cell.top + 'px';
				// Windows 95 style 3D borders
				const baseColor = this.currentFigure.color;
				const lightColor = UIObject.brightenColor(baseColor, 60);
				const darkColor = UIObject.brightenColor(baseColor, -60);
				cellDiv.style.backgroundColor = baseColor;
				cellDiv.style.borderTop = `3px solid ${lightColor}`;
				cellDiv.style.borderLeft = `3px solid ${lightColor}`;
				cellDiv.style.borderRight = `3px solid ${darkColor}`;
				cellDiv.style.borderBottom = `3px solid ${darkColor}`;
				this.playArea.appendChild(cellDiv);
				this.currentFigureElements.push(cellDiv);
			} else {
				const cellDiv = this.currentFigureElements[i];
				cellDiv.style.width = this.cellSize + 'px';
				cellDiv.style.height = this.cellSize + 'px';
				cellDiv.style.left = cell.left + 'px';
				cellDiv.style.top = cell.top + 'px';
			}
		}
	}

	formTetris.reDraw = function () {
		// Calculate cell sizes
		this.cellSize = Math.round(Math.floor((this.contentArea.clientHeight - 15) / (this.gridHeight)));

		// Set game area dimensions
		this.playArea.style.width = (this.cellSize * this.gridWidth) + 'px';
		this.playArea.style.height = (this.cellSize * this.gridHeight) + 'px';

		// Recalculate UI element sizes proportionally
		const uiScale = this.cellSize / 20; // base cell size 20px
		const nextFigureSize = this.cellSize * 6; // 6 cells for preview area
		const textBoxHeight = Math.floor(30 * uiScale);
		const buttonHeight = Math.floor(30 * uiScale);

		if (this.nextFigureArea) {
			this.nextFigureArea.style.width = nextFigureSize + 'px';
			this.nextFigureArea.style.height = nextFigureSize + 'px';
			this.nextFigureSize = this.cellSize; // Use same size as in main field
			this.showNextFigure();
		}

		if (this.scoreTextBox && this.scoreTextBox.getElement()) {
			const scoreElement = this.scoreTextBox.getElement();
			scoreElement.style.width = nextFigureSize + 'px';
			scoreElement.style.height = textBoxHeight + 'px';
			scoreElement.style.fontSize = Math.floor(14 * uiScale) + 'px';
		}

		if (this.levelTextBox && this.levelTextBox.getElement()) {
			const levelElement = this.levelTextBox.getElement();
			levelElement.style.width = nextFigureSize + 'px';
			levelElement.style.height = textBoxHeight + 'px';
			levelElement.style.fontSize = Math.floor(14 * uiScale) + 'px';
		}

		if (this.startButton && this.startButton.getElement()) {
			const startBtnElement = this.startButton.getElement();
			startBtnElement.style.width = nextFigureSize + 'px';
			startBtnElement.style.height = buttonHeight + 'px';
			startBtnElement.style.fontSize = Math.floor(14 * uiScale) + 'px';
		}

		if (this.pauseButton && this.pauseButton.getElement()) {
			const pauseBtnElement = this.pauseButton.getElement();
			pauseBtnElement.style.width = nextFigureSize + 'px';
			pauseBtnElement.style.height = buttonHeight + 'px';
			pauseBtnElement.style.fontSize = Math.floor(14 * uiScale) + 'px';
		}

		// Recalculate coordinates and update element positions
		if (this.grid && this.grid.length > 0) {
			let top = 0;
			let left = 0;
			for (let y = 0; y < this.gridHeight; y++) {
				for (let x = 0; x < this.gridWidth; x++) {
					this.grid[y][x].left = Math.round(left);
					this.grid[y][x].top = Math.round(top);

					// Update element size and position if it exists
					if (this.grid[y][x].element) {
						this.grid[y][x].element.style.width = this.cellSize + 'px';
						this.grid[y][x].element.style.height = this.cellSize + 'px';
						this.grid[y][x].element.style.left = Math.round(left) + 'px';
						this.grid[y][x].element.style.top = Math.round(top) + 'px';
					}
					left += this.cellSize;
				}
				left = 0;
				top += this.cellSize;
			}

			// Update current figure if it exists
			if (this.currentFigureElements) {
				this.showFigure(false);
			}
		}

		// Update Game Over panel sizes
		if (this.gameOverPanel) {
			const panelScale = uiScale;
			this.gameOverPanel.style.padding = Math.floor(20 * panelScale) + 'px ' + Math.floor(35 * panelScale) + 'px';

			if (this.gameOverTitle) {
				this.gameOverTitle.style.fontSize = Math.floor(32 * panelScale) + 'px';
				this.gameOverTitle.style.marginBottom = Math.floor(12 * panelScale) + 'px';
			}

			if (this.gameOverScore) {
				this.gameOverScore.style.fontSize = Math.floor(18 * panelScale) + 'px';
			}
		}
	}

	formTetris.onResizing = function () {
		// Redraw game field on resize
		this.reDraw();
	}

	formTetris.initializeGrid = function () {

		if (this.grid) {
			for (let y = 0; y < this.grid.length; y++) {
				for (let x = 0; x < this.grid[y].length; x++) {
					this.grid[y][x].value = 0;
					if (this.grid[y][x].element)
						this.grid[y][x].element.remove();
					this.grid[y][x].element = null;
				}
			}
		}

		if (this.grid.length !== this.gridHeight || this.grid[0].length !== this.gridWidth) {
			this.grid = [];
			let top = 0;
			let left = 0;
			for (let y = 0; y < this.gridHeight; y++) {
				const row = [];
				for (let x = 0; x < this.gridWidth; x++) {
					row.push({ value: 0, left: left, top: top, element: null });
					left += this.cellSize;
				}
				this.grid.push(row);
				left = 0;
				top += this.cellSize;
			}
		}
	}

	formTetris.Draw = function (parent) {

		// Call base implementation
		Form.prototype.Draw.call(this, parent);

		this.contentArea = this.getContentArea();
		if (!this.contentArea) return;

		// Create container for game and buttons
		const gameContainer = document.createElement('div');
		this.contentArea.appendChild(gameContainer);
		gameContainer.style.display = 'flex';
		gameContainer.style.gap = '10px';
		gameContainer.style.padding = '10px';

		// Create game field
		this.playArea = document.createElement('div');
		gameContainer.appendChild(this.playArea);
		this.playArea.style.position = 'relative';
		this.playArea.style.backgroundColor = '#000000';
		this.playArea.style.border = '1px solid #000';
		this.playArea.style.flexShrink = '0';

		// Create right panel with preview and controls
		const rightPanel = document.createElement('div');
		gameContainer.appendChild(rightPanel);
		rightPanel.style.display = 'flex';
		rightPanel.style.flexDirection = 'column';
		rightPanel.style.gap = '10px';

		// Create next figure display area
		this.nextFigureArea = document.createElement('div');
		rightPanel.appendChild(this.nextFigureArea);
		this.nextFigureArea.style.position = 'relative';
		this.nextFigureArea.style.backgroundColor = '#000000';
		this.nextFigureArea.style.border = '1px solid #000';
		this.nextFigureArea.style.width = '120px';
		this.nextFigureArea.style.height = '120px';
		this.nextFigureSize = 25;

		// Create TextBox for score display
		this.scoreTextBox = new TextBox(rightPanel);
		this.scoreTextBox.setReadOnly(true);
		this.scoreTextBox.setText('Score: 0');
		this.scoreTextBox.Draw(rightPanel);
		const scoreElement = this.scoreTextBox.getElement();
		if (scoreElement) {
			scoreElement.style.width = '120px';
			scoreElement.style.height = '30px';
			scoreElement.style.textAlign = 'center';
		}

		// Create TextBox for level display
		this.levelTextBox = new TextBox(rightPanel);
		this.levelTextBox.setReadOnly(true);
		this.levelTextBox.setText('Level: 1');
		this.levelTextBox.Draw(rightPanel);
		const levelElement = this.levelTextBox.getElement();
		if (levelElement) {
			levelElement.style.width = '120px';
			levelElement.style.height = '30px';
			levelElement.style.textAlign = 'center';
		}

		// Create control buttons
		const controlsDiv = document.createElement('div');
		rightPanel.appendChild(controlsDiv);
		controlsDiv.style.display = 'flex';
		controlsDiv.style.flexDirection = 'column';
		controlsDiv.style.gap = '10px';

		this.startButton = new Button(controlsDiv);
		this.startButton.setCaption('New Game');
		this.startButton.setParent(controlsDiv);
		this.startButton.Draw(controlsDiv);
		this.startButton.onClick = () => {
			this.newGame();
		};
		const startBtnElement = this.startButton.getElement();
		if (startBtnElement) {
			startBtnElement.style.width = '120px';
			startBtnElement.style.height = '30px';
		}

		this.pauseButton = new Button(controlsDiv);
		this.pauseButton.setCaption('Pause');
		this.pauseButton.setParent(controlsDiv);
		this.pauseButton.Draw(controlsDiv);
		this.pauseButton.onClick = () => {
			if (!this.isPaused) {
				// Pause
				this.isPaused = true;
				if (this.gameInterval) {
					clearInterval(this.gameInterval);
					this.gameInterval = null;
				}
				this.pauseButton.setCaption('Resume');
			} else {
				// Resume
				this.isPaused = false;
				if (!this.isGameOver) {
					this.gameInterval = setInterval(() => {
						this.gameStep();
					}, this.speedInterval);
				}
				this.pauseButton.setCaption('Pause');
			}
		};
		const pauseBtnElement = this.pauseButton.getElement();
		if (pauseBtnElement) {
			pauseBtnElement.style.width = '120px';
			pauseBtnElement.style.height = '30px';
		}

		// Create Game Over panel
		this.gameOverPanel = document.createElement('div');
		this.playArea.appendChild(this.gameOverPanel);

		// Position in center of game field
		this.gameOverPanel.style.position = 'absolute';
		this.gameOverPanel.style.left = '50%';
		this.gameOverPanel.style.top = '50%';
		this.gameOverPanel.style.transform = 'translate(-50%, -50%)';
		this.gameOverPanel.style.zIndex = '1000';
		this.gameOverPanel.style.display = 'none'; // Initially hidden

		// Windows 95 style 3D borders (raised button)
		const baseColor = '#C0C0C0';
		const lightColor = UIObject.brightenColor(baseColor, 80);
		const darkColor = UIObject.brightenColor(baseColor, -80);

		this.gameOverPanel.style.backgroundColor = baseColor;
		this.gameOverPanel.style.borderTop = `4px solid ${lightColor}`;
		this.gameOverPanel.style.borderLeft = `4px solid ${lightColor}`;
		this.gameOverPanel.style.borderRight = `4px solid ${darkColor}`;
		this.gameOverPanel.style.borderBottom = `4px solid ${darkColor}`;
		this.gameOverPanel.style.boxSizing = 'border-box';

		// Добавляем заголовок
		this.gameOverTitle = document.createElement('div');
		this.gameOverTitle.textContent = 'GAME OVER';
		this.gameOverTitle.style.fontWeight = 'bold';
		this.gameOverTitle.style.fontFamily = 'Arial, sans-serif';
		this.gameOverTitle.style.color = '#FF0000';
		this.gameOverTitle.style.textAlign = 'center';
		this.gameOverTitle.style.textShadow = '2px 2px 4px rgba(0,0,0,0.5)';
		this.gameOverPanel.appendChild(this.gameOverTitle);

		// Add score
		this.gameOverScore = document.createElement('div');
		this.gameOverScore.style.fontWeight = 'bold';
		this.gameOverScore.style.fontFamily = 'Arial, sans-serif';
		this.gameOverScore.style.color = '#000000';
		this.gameOverScore.style.textAlign = 'center';
		this.gameOverPanel.appendChild(this.gameOverScore);

		// Wait for layout completion (standard practice for complex UI)
		setTimeout(() => {
			this.reDraw();
		}, 50);

	}

	// Initialize figures with colors from generator
	formTetris.initializeFigures = function () {
		return [
			// I
			{
				shape: [
					[[1, 1], [2, 1], [3, 1], [4, 1]],
					[[2, 1], [2, 2], [2, 3], [2, 4]]],
				color: this.getNextColor()
			},
			// J
			{
				shape: [
					[[1, 1], [1, 2], [2, 2], [3, 2]],
					[[2, 1], [3, 1], [2, 2], [2, 3]],
					[[1, 2], [2, 2], [3, 2], [3, 3]],
					[[2, 1], [2, 2], [1, 3], [2, 3]]],
				color: this.getNextColor()
			},
			// L
			{
				shape: [
					[[3, 1], [1, 2], [2, 2], [3, 2]],
					[[2, 1], [2, 2], [2, 3], [3, 3]],
					[[1, 2], [2, 2], [3, 2], [1, 3]],
					[[1, 1], [2, 1], [2, 2], [2, 3]]],
				color: this.getNextColor()
			},
			// O
			{
				shape: [
					[[1, 1], [2, 1], [1, 2], [2, 2]]],
				color: this.getNextColor()
			},
			// S
			{
				shape: [
					[[2, 1], [3, 1], [1, 2], [2, 2]],
					[[2, 1], [2, 2], [3, 2], [3, 3]]],
				color: this.getNextColor()
			},
			// T
			{
				shape: [
					[[2, 1], [1, 2], [2, 2], [3, 2]],
					[[2, 1], [2, 2], [3, 2], [2, 3]],
					[[1, 2], [2, 2], [3, 2], [2, 3]],
					[[2, 1], [1, 2], [2, 2], [2, 3]]],
				color: this.getNextColor()
			},
			// Z
			{
				shape: [
					[[1, 1], [2, 1], [2, 2], [3, 2]],
					[[3, 1], [2, 2], [3, 2], [2, 3]]],
				color: this.getNextColor()
			}
		];
	}

	formTetris.figures = null;

	formTetris.getRandomFigure = function () {
		const index = Math.floor(Math.random() * this.figures.length);
		return this.figures[index];
	}

	formTetris.getFigureStartPosition = function (figure) {
		const shape = figure.shape[0];
		const minX = Math.min(...shape.map(coord => coord[0]));
		const maxX = Math.max(...shape.map(coord => coord[0]));
		const startX = Math.floor((this.gridWidth - (maxX - minX + 1)) / 2) - minX + 1;
		return { x: startX, y: -1 };
	}

	formTetris.startNewLevel = function (level) {
		this.level = level;
		// Exponential speed decrease for uniform acceleration
		this.speedInterval = Math.max(1000 * Math.pow(0.9, this.level - 1), 100);
		if (this.gameInterval) {
			clearInterval(this.gameInterval);
		}

		if (this.setNewFigure(this.currentFigure)) {
			this.showFigure(true);
			// Start game loop
			this.gameInterval = setInterval(() => {
				this.gameStep();
			}, this.speedInterval);
		} else {
			this.setGameOver();
		}


	}

	formTetris.setGameOver = function () {
		this.isGameOver = true;
		if (this.gameInterval) {
			clearInterval(this.gameInterval);
			this.gameInterval = null;
		}
		if (this.moveInterval) {
			clearInterval(this.moveInterval);
			this.moveInterval = null;
		}
		this.showGameOverPanel();
	}

	formTetris.showGameOverPanel = function () {
		if (this.gameOverScore) {
			this.gameOverScore.textContent = 'Score: ' + this.score;
		}
		if (this.gameOverPanel) {
			this.gameOverPanel.style.display = 'block';
		}
	}

	formTetris.hideGameOverPanel = function () {
		if (this.gameOverPanel) {
			this.gameOverPanel.style.display = 'none';
		}
	}

	formTetris.goNextFigure = function () {
		// Fix current figure in grid and recolor to level color
		for (let i = 0; i < this.currentFigureAdresses.length; i++) {
			const cellX = this.currentFigureAdresses[i].x;
			const cellY = this.currentFigureAdresses[i].y;
			this.grid[cellY][cellX].value = 1;
			this.grid[cellY][cellX].element = this.currentFigureElements[i];
			// Recolor block to current level color
			const element = this.currentFigureElements[i];
			const lightColor = UIObject.brightenColor(this.levelColor, 60);
			const darkColor = UIObject.brightenColor(this.levelColor, -60);
			element.style.backgroundColor = this.levelColor;
			element.style.borderTop = `3px solid ${lightColor}`;
			element.style.borderLeft = `3px solid ${lightColor}`;
			element.style.borderRight = `3px solid ${darkColor}`;
			element.style.borderBottom = `3px solid ${darkColor}`;
		}

		// Check filled lines and remove them
		this.checkAndRemoveLines();

		// Switch to next figure
		this.currentFigure = this.nextFigure;
		if (this.cheatMode) {
			// In cheat mode look for best position for current figure
			let { bestAdress: bestAdressForCurrentFugure } = this.findBestFigurePlacement(this.currentFigure);
			if (bestAdressForCurrentFugure) {
				// Temporarily fix figure to calculate next one
				for (let i = 0; i < bestAdressForCurrentFugure.length; i++) {
					const cellX = bestAdressForCurrentFugure[i].x;
					const cellY = bestAdressForCurrentFugure[i].y;
					this.grid[cellY][cellX].value = 1;
				}
				// Now look for not just figure, but its optimal rotation and position
				let minHoles = Infinity;
				let bestY = 0;
				let bestNextFigure = null;
				let bestNextAdress = null;
				let bestNextRotation = 0;
				for (let i = 0; i < this.figures.length; i++) {
					const testFigure = this.figures[i];
					for (let rotation = 0; rotation < testFigure.shape.length; rotation++) {
						// Override findBestFigurePlacement for specific rotation
						let { holes, bestY: y, bestAdress } = this.findBestFigurePlacementWithRotation(testFigure, rotation);
						if (holes < minHoles || (holes === minHoles && y > bestY)) {
							minHoles = holes;
							bestY = y;
							bestNextFigure = testFigure;
							bestNextAdress = bestAdress;
							bestNextRotation = rotation;
						}
					}
				}
				if (bestNextFigure) {
					this.nextFigure = bestNextFigure;
					this.nextFigure.cheatAdress = bestNextAdress;
					this.nextFigure.cheatRotation = bestNextRotation;
				} else {
					this.nextFigure = this.getRandomFigure();
					this.nextFigure.cheatAdress = null;
					this.nextFigure.cheatRotation = 0;
				}
				// Remove temporary figure
				for (let i = 0; i < bestAdressForCurrentFugure.length; i++) {
					const cellX = bestAdressForCurrentFugure[i].x;
					const cellY = bestAdressForCurrentFugure[i].y;
					this.grid[cellY][cellX].value = 0;
				}
			} else {
				this.nextFigure = this.getRandomFigure();
				this.nextFigure.cheatAdress = null;
				this.nextFigure.cheatRotation = 0;
			}
		} else {
			this.nextFigure = this.getRandomFigure();
			this.nextFigure.cheatAdress = null;
			this.nextFigure.cheatRotation = 0;
		}

		this.showNextFigure();
		this.currentFigurePosition = this.getFigureStartPosition(this.currentFigure);
		this.currentFigureRotation = 0;

		// Reset down key state and forbid until release
		if (this.keysPressed) {
			this.keysPressed['ArrowDown'] = false;
			this.dropHoldCount = 0;
			this.allowDownPress = false;
		}

		// Check if new figure can be placed
		if (!this.setNewFigure(this.currentFigure)) {
			this.setGameOver();
			return;
		}

		// Show new figure
		this.showFigure(true);
	}

	// Find best figure position considering specific rotation
	formTetris.findBestFigurePlacementWithRotation = function (figure, rotation) {
		let cellX, cellY;
		let bestX = 0;
		let bestY = 0;
		let minHoles = Infinity;
		let holes = 0;
		let bestAdress = null;
		const shape = figure.shape[rotation];
		for (let x = 0; x < this.gridWidth; x++) {
			let y = 0;
			let localMaxY = 0;
			let Xcollision = false;
			for (y = 0; y < this.gridHeight; y++) {
				let collision = false;
				for (let i = 0; i < shape.length; i++) {
					cellX = x + shape[i][0];
					cellY = y + shape[i][1];
					if (this.checkCollision(cellX, cellY)) {
						collision = true;
						break;
					}
					localMaxY = Math.max(localMaxY, cellY);
				}
				if (collision) {
					if (cellX >= this.gridWidth || cellX < 0) {
						Xcollision = true;
						break;
					}
					y--;
					break;
				}
			}
			if (Xcollision) continue;
			if (y === this.gridHeight) {
				y--;
			}
			holes = 0;
			for (let i = 0; i < shape.length; i++) {
				cellX = x + shape[i][0];
				cellY = y + shape[i][1];
				for (let y2 = cellY + 1; y2 < this.gridHeight; y2++) {
					if (this.grid[y2][cellX].value === 0) {
						holes++;
					} else {
						break;
					}
				}
			}
			let refreshBest = false;
			if (holes < minHoles) {
				refreshBest = true;
				bestY = localMaxY;
				minHoles = holes;
				bestX = x;
			} else if (holes === minHoles) {
				if (localMaxY > bestY) {
					refreshBest = true;
					bestY = localMaxY;
					bestX = x;
				}
			}
			if (refreshBest) {
				bestAdress = [];
				for (let i = 0; i < shape.length; i++) {
					const cellX = bestX + shape[i][0];
					const cellY = bestY - (shape[i][1] - Math.min(...shape.map(s => s[1])));
					bestAdress.push({ x: cellX, y: cellY });
				}
			}
		}
		return { holes: minHoles, bestY, bestAdress };
	}

	// Find best position for current figure (cheat mode)
	formTetris.findBestFigurePlacement = function (figure) {
		let cellX, cellY;
		let bestX = 0;
		let bestY = 0;
		let minHoles = Infinity;
		let holes = 0;
		let bestAdress = null;
		// Iterate all possible X positions
		for (let x = 0; x < this.gridWidth; x++) {
			let Xcollision = false;
			// Iterate all rotations
			for (let rotation = 0; rotation < figure.shape.length; rotation++) {
				const shape = figure.shape[rotation];
				let y = 0;
				let localMaxY = 0; // reset for each rotation
				for (y = 0; y < this.gridHeight; y++) {
					let collision = false;
					for (let i = 0; i < shape.length; i++) {
						cellX = x + shape[i][0];
						cellY = y + shape[i][1];
						if (this.checkCollision(cellX, cellY)) {
							collision = true;
							break;
						}
						localMaxY = Math.max(localMaxY, cellY);
					}
					if (collision) {
						if (cellX >= this.gridWidth || cellX < 0) {
							// Figure doesn't fit on X, skip this position
							Xcollision = true;
							break;
						}
						y--;
						break;
					}
				}
				if (Xcollision) continue; // if doesn't fit, try next rotation
				// If reached bottom without collision, correct Y
				if (y === this.gridHeight) {
					y--;
				}
				// Count holes under figure
				holes = 0;
				for (let i = 0; i < shape.length; i++) {
					cellX = x + shape[i][0];
					cellY = y + shape[i][1];
					for (let y2 = cellY + 1; y2 < this.gridHeight; y2++) {
						if (this.grid[y2][cellX].value === 0) {
							holes++;
						} else {
							break;
						}
					}
				}
				// Update best position
				let refreshBest = false;
				if (holes < minHoles) {
					refreshBest = true;
					bestY = localMaxY;
					minHoles = holes;
					bestX = x;
				} else if (holes === minHoles) {
					// If holes are equal, choose position with larger Y (lower)
					if (localMaxY > bestY) {
						refreshBest = true;
						bestY = localMaxY;
						bestX = x;
					}
				}
				if (refreshBest) {
					bestAdress = [];
					for (let i = 0; i < shape.length; i++) {
						const cellX = bestX + shape[i][0];
						const cellY = bestY - (shape[i][1] - Math.min(...shape.map(s => s[1])));
						bestAdress.push({ x: cellX, y: cellY });
					}
				}
			}
		}
		return { holes, bestY, bestAdress };
	}

	formTetris.checkAndRemoveLines = function () {
		// Find all filled lines
		const fullLines = [];
		for (let y = 0; y < this.gridHeight; y++) {
			let isFull = true;
			for (let x = 0; x < this.gridWidth; x++) {
				if (this.grid[y][x].value === 0) {
					isFull = false;
					break;
				}
			}
			if (isFull) {
				fullLines.push(y);
			}
		}

		const linesRemoved = fullLines.length;
		if (linesRemoved === 0) return;

		// Remove visual elements of filled lines
		for (let y of fullLines) {
			for (let x = 0; x < this.gridWidth; x++) {
				const elem = this.grid[y][x].element;
				if (elem) {
					elem.remove();
				}
			}
		}

		// Shift rows down
		// Start from lowest removed line and go up
		let targetRow = this.gridHeight - 1;
		for (let sourceRow = this.gridHeight - 1; sourceRow >= 0; sourceRow--) {
			if (!fullLines.includes(sourceRow)) {
				// This row is not removed, copy it to target position
				if (sourceRow !== targetRow) {
					for (let x = 0; x < this.gridWidth; x++) {
						this.grid[targetRow][x].value = this.grid[sourceRow][x].value;
						this.grid[targetRow][x].element = this.grid[sourceRow][x].element;

						// Update element position
						if (this.grid[targetRow][x].element) {
							this.grid[targetRow][x].element.style.top = this.grid[targetRow][x].top + 'px';
							this.grid[targetRow][x].element.style.left = this.grid[targetRow][x].left + 'px';
						}
					}
				}
				targetRow--;
			}
		}

		// Clear top rows
		for (let y = 0; y <= targetRow; y++) {
			for (let x = 0; x < this.gridWidth; x++) {
				this.grid[y][x].value = 0;
				this.grid[y][x].element = null;
			}
		}

		// Update score
		this.linesCleared += linesRemoved;
		let scoreIncrement = 0;
		switch (linesRemoved) {
			case 1:
				scoreIncrement = 100;
				break;
			case 2:
				scoreIncrement = 300;
				break;
			case 3:
				scoreIncrement = 500;
				break;
			case 4:
				scoreIncrement = 800;
				break;
		}
		this.score += scoreIncrement;
		this.updateScore();

		// Check if level up is needed
		this.checkLevelUp();
	}

	formTetris.updateScore = function () {
		if (this.scoreTextBox) {
			this.scoreTextBox.setText('Score: ' + this.score);
		}
	}

	formTetris.checkLevelUp = function () {
		const newLevel = Math.floor(this.linesCleared / this.linesPerLevel) + 1;
		if (newLevel > this.level) {
			this.level = newLevel;
			this.levelColor = this.getNextColor();
			this.updateLevel();
		}
	}

	formTetris.updateLevel = function () {
		if (this.levelTextBox) {
			this.levelTextBox.setText('Level: ' + this.level);
		}

		// Increase game speed
		this.speedInterval = Math.max(1000 * Math.pow(0.9, this.level - 1), 100);

		// Restart game loop with new speed
		if (this.gameInterval) {
			clearInterval(this.gameInterval);
			this.gameInterval = setInterval(() => {
				this.gameStep();
			}, this.speedInterval);
		}
	}

	formTetris.showNextFigure = function () {
		if (!this.nextFigureArea || !this.nextFigure) return;

		// Clear previous preview
		this.nextFigureArea.innerHTML = '';

		const shape = this.nextFigure.shape[0];
		const minX = Math.min(...shape.map(coord => coord[0]));
		const maxX = Math.max(...shape.map(coord => coord[0]));
		const minY = Math.min(...shape.map(coord => coord[1]));
		const maxY = Math.max(...shape.map(coord => coord[1]));

		const figureWidth = maxX - minX + 1;
		const figureHeight = maxY - minY + 1;

		// Get area dimensions for centering
		const areaWidth = parseInt(this.nextFigureArea.style.width);
		const areaHeight = parseInt(this.nextFigureArea.style.height);

		// Calculate offset for figure centering
		const offsetX = (areaWidth - figureWidth * this.nextFigureSize) / 2;
		const offsetY = (areaHeight - figureHeight * this.nextFigureSize) / 2;

		for (let i = 0; i < shape.length; i++) {
			const cellX = shape[i][0] - minX;
			const cellY = shape[i][1] - minY;

			const cellDiv = document.createElement('div');
			cellDiv.style.position = 'absolute';
			cellDiv.style.boxSizing = 'border-box';
			cellDiv.style.width = this.nextFigureSize + 'px';
			cellDiv.style.height = this.nextFigureSize + 'px';
			cellDiv.style.left = (offsetX + cellX * this.nextFigureSize) + 'px';
			cellDiv.style.top = (offsetY + cellY * this.nextFigureSize) + 'px';

			// Windows 95 style 3D borders
			const baseColor = this.nextFigure.color;
			const lightColor = UIObject.brightenColor(baseColor, 60);
			const darkColor = UIObject.brightenColor(baseColor, -60);
			cellDiv.style.backgroundColor = baseColor;
			cellDiv.style.borderTop = `3px solid ${lightColor}`;
			cellDiv.style.borderLeft = `3px solid ${lightColor}`;
			cellDiv.style.borderRight = `3px solid ${darkColor}`;
			cellDiv.style.borderBottom = `3px solid ${darkColor}`;

			this.nextFigureArea.appendChild(cellDiv);
		}
	}

	formTetris.moveFigureDown = function () {
		const newAddresses = [];
		let isCollision = false;
		this.currentFigureAdresses.forEach(elem => {
			let newAdress = { x: elem.x, y: elem.y + 1 };
			if (this.checkCollision(newAdress.x, newAdress.y)) {
				isCollision = true;
			}
			newAddresses.push(newAdress);
		});
		if (isCollision) {
			this.goNextFigure();
			return false; // Figure fixed, nothing more to drop
		} else {
			this.currentFigureAdresses = newAddresses;
			this.showFigure(false);
			return true; // Successfully dropped one step
		}
	}


	formTetris.moveFigureLeft = function (tempAddresses = undefined) {
		const newAddresses = [];
		let isCollision = false;
		let addressesToUse = tempAddresses || this.currentFigureAdresses;
		addressesToUse.forEach(elem => {
			let newAdress = { x: elem.x - 1, y: elem.y };
			if (this.checkCollision(newAdress.x, newAdress.y)) {
				isCollision = true;
			}
			newAddresses.push(newAdress);
		});
		if (tempAddresses) {
			for (let i = 0; i < newAddresses.length; i++) {
				tempAddresses[i] = newAddresses[i];
			}
		}
		if (!isCollision) {
			this.currentFigureAdresses = newAddresses;
			this.showFigure(false);
			return true;
		} else {
			return false;
		}
	}

	formTetris.moveFigureRight = function (tempAddresses = undefined) {
		const newAddresses = [];
		let isCollision = false;
		let addressesToUse = tempAddresses || this.currentFigureAdresses;
		addressesToUse.forEach(elem => {
			let newAdress = { x: elem.x + 1, y: elem.y };
			if (this.checkCollision(newAdress.x, newAdress.y)) {
				isCollision = true;
			}
			newAddresses.push(newAdress);
		});
		if (tempAddresses) {
			for (let i = 0; i < newAddresses.length; i++) {
				tempAddresses[i] = newAddresses[i];
			}
		}
		if (!isCollision) {
			this.currentFigureAdresses = newAddresses;
			this.showFigure(false);
			return true;
		} else {
			return false;
		}
	}

	formTetris.rotateFigure = function () {
		const newAddresses = [];
		let isCollision = false;
		const newFigureRotation = (this.currentFigureRotation + 1) % this.currentFigure.shape.length;
		const currentShape = this.currentFigure.shape[this.currentFigureRotation];
		const newShape = this.currentFigure.shape[newFigureRotation];
		for (let i = 0; i < this.currentFigureAdresses.length; i++) {
			const shiftX = newShape[i][0] - currentShape[i][0];
			const shiftY = newShape[i][1] - currentShape[i][1];
			const newAdress = {
				x: this.currentFigureAdresses[i].x + shiftX,
				y: this.currentFigureAdresses[i].y + shiftY
			};
			if (this.checkCollision(newAdress.x, newAdress.y)) {
				isCollision = true;
			}
			newAddresses.push(newAdress);
		}
		if (isCollision) {
			//Try to shift figure left or right
			//For stick need up to 3 attempts each side
			//Number of shift attempts depends on figure size
			const maxShifts = Math.max(...newShape.map(coord => coord[0])) - Math.min(...newShape.map(coord => coord[0])) + 1;

			//Attempt to shift left
			let tempAddresses = newAddresses.slice();
			for (let shift = 1; shift <= maxShifts; shift++) {
				if (this.moveFigureLeft(tempAddresses)) {
					this.currentFigureRotation = newFigureRotation;
					this.currentFigureAdresses = tempAddresses;
					this.showFigure(false);
					return;
				}
			}
			//Attempt to shift right
			tempAddresses = newAddresses.slice();
			for (let shift = 1; shift <= maxShifts; shift++) {
				if (this.moveFigureRight(tempAddresses)) {
					this.currentFigureRotation = newFigureRotation;
					this.currentFigureAdresses = tempAddresses;
					this.showFigure(false);
					return;
				}
			}
		} else {
			// No collision - just apply rotation
			this.currentFigureRotation = newFigureRotation;
			this.currentFigureAdresses = newAddresses;
			this.showFigure(false);
		}
	}

	formTetris.gameStep = function () {
		this.moveFigureDown();
	}

	formTetris.newGame = function () {
		this.hideGameOverPanel();
		this.initializeGrid();
		setTimeout(() => {
			if (this.currentFigureElements) {
				for (let element of this.currentFigureElements) {
					element.remove();
				}
			}
			if (this.moveInterval) {
				clearInterval(this.moveInterval);
				this.moveInterval = null;
			}
			this.keysPressed = {};
			this.dropHoldCount = 0;
			this.colorIndex = 0;
			this.figures = this.initializeFigures();
			this.levelColor = this.getNextColor();
			this.currentFigure = this.getRandomFigure();
			this.nextFigure = this.getRandomFigure();
			this.currentFigurePosition = this.getFigureStartPosition(this.currentFigure);
			this.currentFigureRotation = 0;
			this.score = 0;
			this.level = 1;
			this.linesCleared = 0;
			this.isGameOver = false;
			this.updateScore();
			this.updateLevel();
			this.showNextFigure();
			this.startNewLevel(this.level);
		}, 200);
	}

	formTetris.Draw(document.body);
})();


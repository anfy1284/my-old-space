// Приложение "Тетрис".
//
// Паттерн MySpace: client.js только РЕГИСТРИРУЕТ дескриптор приложения
// (MySpace.register), окно создаётся в createInstance() при MySpace.open()
// из меню. Никакой отрисовки на этапе загрузки бандла — иначе игра
// открывалась бы сразу при входе в систему.
(function () {
    const APP_NAME = 'tetris';

    const ICON_NEW   = '/apps/general_icons/resources/public/16x16/refresh.png';
    const ICON_PAUSE = '/apps/general_icons/resources/public/16x16/pause.png';
    const ICON_PLAY  = '/apps/general_icons/resources/public/16x16/play.png';

    const descriptor = {
        // Одно окно игры (singleton): повторный пункт меню активирует существующее.
        config: { allowMultipleInstances: false },

        createInstance: async function (params) {
            const appForm = new DataForm(APP_NAME);
            appForm.setTitle('Tetris');
            appForm.setWidth(360);
            appForm.setHeight(540);
            appForm.setAnchorToWindow('center');

            // ── Состояние игры ───────────────────────────────────────────────
            const game = {
                gridWidth: 10,
                gridHeight: 20,
                linesPerLevel: 10,
                grid: [],
                cellSize: 0,
                currentFigure: null,
                currentFigurePosition: { x: 0, y: 0 },
                currentFigureRotation: 0,
                score: 0,
                level: 1,
                linesCleared: 0,
                gameInterval: null,
                speedInterval: 0,
                isGameOver: false,
                nextFigure: null,
                currentFigureElements: null,
                currentFigureAdresses: null,
                nextFigureSize: 0,
                colorIndex: 0,
                levelColor: null,
                keysPressed: {},
                moveInterval: null,
                moveDelay: 100,
                dropHoldCount: 0,
                allowDownPress: true,
                isPaused: false,
                cheatMode: false,
                figures: null,
                colors: ['#00FFFF', '#0000FF', '#FFA500', '#FFFF00', '#00FF00', '#800080', '#FF0000'],
                // DOM / контролы
                contentArea: null,
                gameContainer: null,
                playArea: null,
                rightPanel: null,
                nextFigureArea: null,
                scorePanel: null,
                levelPanel: null,
                startButton: null,
                pauseButton: null,
                gameOverPanel: null,
                gameOverTitle: null,
                gameOverScore: null
            };

            // Подписи (переводятся на сервере через маркер __t при отдаче файла).
            const T = {
                score: __t('tetris_score'),
                level: __t('tetris_level'),
                newGame: __t('tetris_new_game'),
                pause: __t('tetris_pause'),
                resume: __t('tetris_resume'),
                gameOver: __t('tetris_game_over')
            };

            game.getNextColor = function () {
                const color = this.colors[this.colorIndex];
                this.colorIndex = (this.colorIndex + 1) % this.colors.length;
                return color;
            };

            game.stop = function () {
                if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
                if (this.moveInterval) { clearInterval(this.moveInterval); this.moveInterval = null; }
            };

            game.processKeyActions = function () {
                if (this.isGameOver || this.isPaused) return;
                if (this.keysPressed['ArrowUp']) {
                    this.rotateFigure();
                    this.keysPressed['ArrowUp'] = false;
                }
                if (this.keysPressed['ArrowLeft']) this.moveFigureLeft();
                if (this.keysPressed['ArrowRight']) this.moveFigureRight();
                if (this.keysPressed['ArrowDown']) {
                    if (this.dropHoldCount < 3) {
                        this.moveFigureDown();
                        this.dropHoldCount++;
                    } else {
                        while (this.moveFigureDown()) { }
                        this.dropHoldCount = 0;
                    }
                }
            };

            game.checkCollision = function (cellX, cellY) {
                return (cellX < 0 || cellX >= this.gridWidth || cellY < 0 || cellY >= this.gridHeight || this.grid[cellY][cellX].value !== 0);
            };

            game.setNewFigure = function (newFigure) {
                const shape = newFigure.shape[0];
                this.currentFigureAdresses = [];
                for (let i = 0; i < shape.length; i++) {
                    const cellX = this.currentFigurePosition.x + shape[i][0];
                    const cellY = this.currentFigurePosition.y + shape[i][1];
                    if (this.checkCollision(cellX, cellY)) return false;
                    this.currentFigureAdresses.push({ x: cellX, y: cellY });
                }
                return true;
            };

            game.styleBlock = function (cellDiv, baseColor) {
                const lightColor = UIObject.brightenColor(baseColor, 60);
                const darkColor = UIObject.brightenColor(baseColor, -60);
                cellDiv.style.backgroundColor = baseColor;
                cellDiv.style.borderTop = `3px solid ${lightColor}`;
                cellDiv.style.borderLeft = `3px solid ${lightColor}`;
                cellDiv.style.borderRight = `3px solid ${darkColor}`;
                cellDiv.style.borderBottom = `3px solid ${darkColor}`;
            };

            game.showFigure = function (isNew = false) {
                if (isNew) this.currentFigureElements = [];
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
                        this.styleBlock(cellDiv, this.currentFigure.color);
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
            };

            // Пересчёт размеров под текущую область контента (без скроллов).
            game.reDraw = function () {
                if (!this.contentArea) return;
                const cw = this.contentArea.clientWidth;
                const ch = this.contentArea.clientHeight;
                if (cw <= 0 || ch <= 0) return;

                const pad = 8;
                const gap = 8;
                // Ширина правой панели держится пропорционально клетке (5 клеток).
                // Итоговая ширина: pad*2 + 10*cell (поле) + gap + 5*cell (панель).
                const cellByW = Math.floor((cw - pad * 2 - gap) / (this.gridWidth + 5));
                const cellByH = Math.floor((ch - pad * 2) / this.gridHeight);
                this.cellSize = Math.max(8, Math.min(cellByW, cellByH));

                const panelW = this.cellSize * 5;

                this.playArea.style.width = (this.cellSize * this.gridWidth) + 'px';
                this.playArea.style.height = (this.cellSize * this.gridHeight) + 'px';

                const uiScale = this.cellSize / 22;
                const fontSize = Math.max(11, Math.floor(14 * uiScale));
                const ctrlHeight = Math.max(24, Math.floor(32 * uiScale));

                this.rightPanel.style.width = panelW + 'px';

                if (this.nextFigureArea) {
                    this.nextFigureArea.style.width = panelW + 'px';
                    this.nextFigureArea.style.height = panelW + 'px';
                    this.nextFigureSize = this.cellSize;
                    this.showNextFigure();
                }

                [this.scorePanel, this.levelPanel].forEach(p => {
                    if (!p) return;
                    p.style.height = ctrlHeight + 'px';
                    p.style.lineHeight = ctrlHeight + 'px';
                    p.style.fontSize = fontSize + 'px';
                });

                [this.startButton, this.pauseButton].forEach(b => {
                    if (!b || !b.getElement()) return;
                    const el = b.getElement();
                    el.style.width = '100%';
                    el.style.height = ctrlHeight + 'px';
                    el.style.fontSize = fontSize + 'px';
                });

                // Пересчёт координат сетки и позиций уложенных блоков.
                if (this.grid && this.grid.length > 0) {
                    let top = 0, left = 0;
                    for (let y = 0; y < this.gridHeight; y++) {
                        for (let x = 0; x < this.gridWidth; x++) {
                            this.grid[y][x].left = Math.round(left);
                            this.grid[y][x].top = Math.round(top);
                            const el = this.grid[y][x].element;
                            if (el) {
                                el.style.width = this.cellSize + 'px';
                                el.style.height = this.cellSize + 'px';
                                el.style.left = Math.round(left) + 'px';
                                el.style.top = Math.round(top) + 'px';
                            }
                            left += this.cellSize;
                        }
                        left = 0;
                        top += this.cellSize;
                    }
                    if (this.currentFigureElements) this.showFigure(false);
                }

                if (this.gameOverPanel) {
                    this.gameOverPanel.style.padding = Math.floor(16 * uiScale) + 'px ' + Math.floor(28 * uiScale) + 'px';
                    if (this.gameOverTitle) {
                        this.gameOverTitle.style.fontSize = Math.floor(26 * uiScale) + 'px';
                        this.gameOverTitle.style.marginBottom = Math.floor(10 * uiScale) + 'px';
                    }
                    if (this.gameOverScore) this.gameOverScore.style.fontSize = Math.floor(16 * uiScale) + 'px';
                }
            };

            game.initializeGrid = function () {
                if (this.grid) {
                    for (let y = 0; y < this.grid.length; y++) {
                        for (let x = 0; x < this.grid[y].length; x++) {
                            this.grid[y][x].value = 0;
                            if (this.grid[y][x].element) this.grid[y][x].element.remove();
                            this.grid[y][x].element = null;
                        }
                    }
                }
                if (this.grid.length !== this.gridHeight || (this.grid[0] && this.grid[0].length !== this.gridWidth) || this.grid.length === 0) {
                    this.grid = [];
                    let top = 0, left = 0;
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
            };

            game.initializeFigures = function () {
                return [
                    { shape: [[[1, 1], [2, 1], [3, 1], [4, 1]], [[2, 1], [2, 2], [2, 3], [2, 4]]], color: this.getNextColor() }, // I
                    { shape: [[[1, 1], [1, 2], [2, 2], [3, 2]], [[2, 1], [3, 1], [2, 2], [2, 3]], [[1, 2], [2, 2], [3, 2], [3, 3]], [[2, 1], [2, 2], [1, 3], [2, 3]]], color: this.getNextColor() }, // J
                    { shape: [[[3, 1], [1, 2], [2, 2], [3, 2]], [[2, 1], [2, 2], [2, 3], [3, 3]], [[1, 2], [2, 2], [3, 2], [1, 3]], [[1, 1], [2, 1], [2, 2], [2, 3]]], color: this.getNextColor() }, // L
                    { shape: [[[1, 1], [2, 1], [1, 2], [2, 2]]], color: this.getNextColor() }, // O
                    { shape: [[[2, 1], [3, 1], [1, 2], [2, 2]], [[2, 1], [2, 2], [3, 2], [3, 3]]], color: this.getNextColor() }, // S
                    { shape: [[[2, 1], [1, 2], [2, 2], [3, 2]], [[2, 1], [2, 2], [3, 2], [2, 3]], [[1, 2], [2, 2], [3, 2], [2, 3]], [[2, 1], [1, 2], [2, 2], [2, 3]]], color: this.getNextColor() }, // T
                    { shape: [[[1, 1], [2, 1], [2, 2], [3, 2]], [[3, 1], [2, 2], [3, 2], [2, 3]]], color: this.getNextColor() } // Z
                ];
            };

            game.getRandomFigure = function () {
                return this.figures[Math.floor(Math.random() * this.figures.length)];
            };

            game.getFigureStartPosition = function (figure) {
                const shape = figure.shape[0];
                const minX = Math.min(...shape.map(c => c[0]));
                const maxX = Math.max(...shape.map(c => c[0]));
                const startX = Math.floor((this.gridWidth - (maxX - minX + 1)) / 2) - minX + 1;
                return { x: startX, y: -1 };
            };

            game.startNewLevel = function (level) {
                this.level = level;
                this.speedInterval = Math.max(1000 * Math.pow(0.9, this.level - 1), 100);
                if (this.gameInterval) clearInterval(this.gameInterval);
                if (this.setNewFigure(this.currentFigure)) {
                    this.showFigure(true);
                    this.gameInterval = setInterval(() => this.gameStep(), this.speedInterval);
                } else {
                    this.setGameOver();
                }
            };

            game.setGameOver = function () {
                this.isGameOver = true;
                this.stop();
                this.showGameOverPanel();
            };

            game.showGameOverPanel = function () {
                if (this.gameOverScore) this.gameOverScore.textContent = T.score + ': ' + this.score;
                if (this.gameOverPanel) this.gameOverPanel.style.display = 'block';
            };

            game.hideGameOverPanel = function () {
                if (this.gameOverPanel) this.gameOverPanel.style.display = 'none';
            };

            game.goNextFigure = function () {
                for (let i = 0; i < this.currentFigureAdresses.length; i++) {
                    const cellX = this.currentFigureAdresses[i].x;
                    const cellY = this.currentFigureAdresses[i].y;
                    this.grid[cellY][cellX].value = 1;
                    this.grid[cellY][cellX].element = this.currentFigureElements[i];
                    this.styleBlock(this.currentFigureElements[i], this.levelColor);
                }
                this.checkAndRemoveLines();
                this.currentFigure = this.nextFigure;
                this.nextFigure = this.getRandomFigure();
                this.showNextFigure();
                this.currentFigurePosition = this.getFigureStartPosition(this.currentFigure);
                this.currentFigureRotation = 0;
                if (this.keysPressed) {
                    this.keysPressed['ArrowDown'] = false;
                    this.dropHoldCount = 0;
                    this.allowDownPress = false;
                }
                if (!this.setNewFigure(this.currentFigure)) { this.setGameOver(); return; }
                this.showFigure(true);
            };

            game.checkAndRemoveLines = function () {
                const fullLines = [];
                for (let y = 0; y < this.gridHeight; y++) {
                    let isFull = true;
                    for (let x = 0; x < this.gridWidth; x++) {
                        if (this.grid[y][x].value === 0) { isFull = false; break; }
                    }
                    if (isFull) fullLines.push(y);
                }
                const linesRemoved = fullLines.length;
                if (linesRemoved === 0) return;

                for (let y of fullLines) {
                    for (let x = 0; x < this.gridWidth; x++) {
                        const elem = this.grid[y][x].element;
                        if (elem) elem.remove();
                    }
                }
                let targetRow = this.gridHeight - 1;
                for (let sourceRow = this.gridHeight - 1; sourceRow >= 0; sourceRow--) {
                    if (!fullLines.includes(sourceRow)) {
                        if (sourceRow !== targetRow) {
                            for (let x = 0; x < this.gridWidth; x++) {
                                this.grid[targetRow][x].value = this.grid[sourceRow][x].value;
                                this.grid[targetRow][x].element = this.grid[sourceRow][x].element;
                                if (this.grid[targetRow][x].element) {
                                    this.grid[targetRow][x].element.style.top = this.grid[targetRow][x].top + 'px';
                                    this.grid[targetRow][x].element.style.left = this.grid[targetRow][x].left + 'px';
                                }
                            }
                        }
                        targetRow--;
                    }
                }
                for (let y = 0; y <= targetRow; y++) {
                    for (let x = 0; x < this.gridWidth; x++) {
                        this.grid[y][x].value = 0;
                        this.grid[y][x].element = null;
                    }
                }
                this.linesCleared += linesRemoved;
                const increments = { 1: 100, 2: 300, 3: 500, 4: 800 };
                this.score += (increments[linesRemoved] || 0);
                this.updateScore();
                this.checkLevelUp();
            };

            game.updateScore = function () {
                if (this.scorePanel) this.scorePanel.textContent = T.score + ': ' + this.score;
            };

            game.checkLevelUp = function () {
                const newLevel = Math.floor(this.linesCleared / this.linesPerLevel) + 1;
                if (newLevel > this.level) {
                    this.level = newLevel;
                    this.levelColor = this.getNextColor();
                    this.updateLevel();
                }
            };

            game.updateLevel = function () {
                if (this.levelPanel) this.levelPanel.textContent = T.level + ': ' + this.level;
                this.speedInterval = Math.max(1000 * Math.pow(0.9, this.level - 1), 100);
                if (this.gameInterval) {
                    clearInterval(this.gameInterval);
                    this.gameInterval = setInterval(() => this.gameStep(), this.speedInterval);
                }
            };

            game.showNextFigure = function () {
                if (!this.nextFigureArea || !this.nextFigure) return;
                this.nextFigureArea.innerHTML = '';
                const shape = this.nextFigure.shape[0];
                const minX = Math.min(...shape.map(c => c[0]));
                const maxX = Math.max(...shape.map(c => c[0]));
                const minY = Math.min(...shape.map(c => c[1]));
                const maxY = Math.max(...shape.map(c => c[1]));
                const figureWidth = maxX - minX + 1;
                const figureHeight = maxY - minY + 1;
                const areaWidth = parseInt(this.nextFigureArea.style.width);
                const areaHeight = parseInt(this.nextFigureArea.style.height);
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
                    this.styleBlock(cellDiv, this.nextFigure.color);
                    this.nextFigureArea.appendChild(cellDiv);
                }
            };

            game.moveFigureDown = function () {
                const newAddresses = [];
                let isCollision = false;
                this.currentFigureAdresses.forEach(elem => {
                    const a = { x: elem.x, y: elem.y + 1 };
                    if (this.checkCollision(a.x, a.y)) isCollision = true;
                    newAddresses.push(a);
                });
                if (isCollision) { this.goNextFigure(); return false; }
                this.currentFigureAdresses = newAddresses;
                this.showFigure(false);
                return true;
            };

            game.moveFigureLeft = function (tempAddresses) {
                const newAddresses = [];
                let isCollision = false;
                const src = tempAddresses || this.currentFigureAdresses;
                src.forEach(elem => {
                    const a = { x: elem.x - 1, y: elem.y };
                    if (this.checkCollision(a.x, a.y)) isCollision = true;
                    newAddresses.push(a);
                });
                if (tempAddresses) for (let i = 0; i < newAddresses.length; i++) tempAddresses[i] = newAddresses[i];
                if (!isCollision) { this.currentFigureAdresses = newAddresses; this.showFigure(false); return true; }
                return false;
            };

            game.moveFigureRight = function (tempAddresses) {
                const newAddresses = [];
                let isCollision = false;
                const src = tempAddresses || this.currentFigureAdresses;
                src.forEach(elem => {
                    const a = { x: elem.x + 1, y: elem.y };
                    if (this.checkCollision(a.x, a.y)) isCollision = true;
                    newAddresses.push(a);
                });
                if (tempAddresses) for (let i = 0; i < newAddresses.length; i++) tempAddresses[i] = newAddresses[i];
                if (!isCollision) { this.currentFigureAdresses = newAddresses; this.showFigure(false); return true; }
                return false;
            };

            game.rotateFigure = function () {
                const newAddresses = [];
                let isCollision = false;
                const newRotation = (this.currentFigureRotation + 1) % this.currentFigure.shape.length;
                const currentShape = this.currentFigure.shape[this.currentFigureRotation];
                const newShape = this.currentFigure.shape[newRotation];
                for (let i = 0; i < this.currentFigureAdresses.length; i++) {
                    const shiftX = newShape[i][0] - currentShape[i][0];
                    const shiftY = newShape[i][1] - currentShape[i][1];
                    const a = { x: this.currentFigureAdresses[i].x + shiftX, y: this.currentFigureAdresses[i].y + shiftY };
                    if (this.checkCollision(a.x, a.y)) isCollision = true;
                    newAddresses.push(a);
                }
                if (isCollision) {
                    const maxShifts = Math.max(...newShape.map(c => c[0])) - Math.min(...newShape.map(c => c[0])) + 1;
                    let temp = newAddresses.slice();
                    for (let s = 1; s <= maxShifts; s++) {
                        if (this.moveFigureLeft(temp)) { this.currentFigureRotation = newRotation; this.currentFigureAdresses = temp; this.showFigure(false); return; }
                    }
                    temp = newAddresses.slice();
                    for (let s = 1; s <= maxShifts; s++) {
                        if (this.moveFigureRight(temp)) { this.currentFigureRotation = newRotation; this.currentFigureAdresses = temp; this.showFigure(false); return; }
                    }
                } else {
                    this.currentFigureRotation = newRotation;
                    this.currentFigureAdresses = newAddresses;
                    this.showFigure(false);
                }
            };

            game.gameStep = function () { this.moveFigureDown(); };

            game.newGame = function () {
                this.hideGameOverPanel();
                this.stop();
                this.initializeGrid();
                if (this.currentFigureElements) {
                    for (let element of this.currentFigureElements) element.remove();
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
                this.isPaused = false;
                this.syncPauseButton();
                this.updateScore();
                this.updateLevel();
                this.showNextFigure();
                this.startNewLevel(this.level);
            };

            game.togglePause = function () {
                if (this.isGameOver) return;
                if (!this.isPaused) {
                    this.isPaused = true;
                    if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
                } else {
                    this.isPaused = false;
                    this.gameInterval = setInterval(() => this.gameStep(), this.speedInterval);
                }
                this.syncPauseButton();
            };

            game.syncPauseButton = function () {
                if (!this.pauseButton) return;
                if (this.isPaused) {
                    this.pauseButton.setCaption(T.resume);
                    this.pauseButton.setIcon(ICON_PLAY);
                } else {
                    this.pauseButton.setCaption(T.pause);
                    this.pauseButton.setIcon(ICON_PAUSE);
                }
            };

            // ── Построение интерфейса ─────────────────────────────────────────
            game.buildUI = function (content) {
                this.contentArea = content;
                content.innerHTML = '';
                content.style.padding = '0';
                content.style.overflow = 'hidden'; // размерами управляем сами — без скроллов

                const gameContainer = document.createElement('div');
                content.appendChild(gameContainer);
                this.gameContainer = gameContainer;
                gameContainer.style.display = 'flex';
                gameContainer.style.gap = '8px';
                gameContainer.style.padding = '8px';
                gameContainer.style.boxSizing = 'border-box';
                gameContainer.style.width = '100%';
                gameContainer.style.height = '100%';
                gameContainer.style.overflow = 'hidden';
                gameContainer.style.alignItems = 'flex-start';

                // Игровое поле
                this.playArea = document.createElement('div');
                gameContainer.appendChild(this.playArea);
                this.playArea.style.position = 'relative';
                this.playArea.style.backgroundColor = '#000000';
                this.playArea.style.flexShrink = '0';
                // Утопленная рамка Win95
                this.playArea.style.borderTop = '2px solid #808080';
                this.playArea.style.borderLeft = '2px solid #808080';
                this.playArea.style.borderRight = '2px solid #ffffff';
                this.playArea.style.borderBottom = '2px solid #ffffff';

                // Правая панель
                this.rightPanel = document.createElement('div');
                gameContainer.appendChild(this.rightPanel);
                this.rightPanel.style.display = 'flex';
                this.rightPanel.style.flexDirection = 'column';
                this.rightPanel.style.gap = '8px';
                this.rightPanel.style.flexShrink = '0';

                // Превью следующей фигуры
                this.nextFigureArea = document.createElement('div');
                this.rightPanel.appendChild(this.nextFigureArea);
                this.nextFigureArea.style.position = 'relative';
                this.nextFigureArea.style.backgroundColor = '#000000';
                this.nextFigureArea.style.boxSizing = 'border-box';
                this.nextFigureArea.style.borderTop = '2px solid #808080';
                this.nextFigureArea.style.borderLeft = '2px solid #808080';
                this.nextFigureArea.style.borderRight = '2px solid #ffffff';
                this.nextFigureArea.style.borderBottom = '2px solid #ffffff';

                // Панели счёта/уровня (утопленные)
                const makeStat = () => {
                    const p = document.createElement('div');
                    this.rightPanel.appendChild(p);
                    p.style.boxSizing = 'border-box';
                    p.style.padding = '0 6px';
                    p.style.textAlign = 'center';
                    p.style.fontFamily = 'MS Sans Serif, Tahoma, sans-serif';
                    p.style.backgroundColor = '#ffffff';
                    p.style.borderTop = '2px solid #808080';
                    p.style.borderLeft = '2px solid #808080';
                    p.style.borderRight = '2px solid #ffffff';
                    p.style.borderBottom = '2px solid #ffffff';
                    p.style.whiteSpace = 'nowrap';
                    p.style.overflow = 'hidden';
                    return p;
                };
                this.scorePanel = makeStat();
                this.levelPanel = makeStat();

                // Кнопки управления
                this.startButton = new Button(this.rightPanel, { caption: T.newGame, icon: ICON_NEW, showIcon: true });
                this.startButton.Draw(this.rightPanel);
                this.startButton.onClick = () => this.newGame();

                this.pauseButton = new Button(this.rightPanel, { caption: T.pause, icon: ICON_PAUSE, showIcon: true });
                this.pauseButton.Draw(this.rightPanel);
                this.pauseButton.onClick = () => this.togglePause();

                // Панель Game Over (поверх поля)
                this.gameOverPanel = document.createElement('div');
                this.playArea.appendChild(this.gameOverPanel);
                this.gameOverPanel.style.position = 'absolute';
                this.gameOverPanel.style.left = '50%';
                this.gameOverPanel.style.top = '50%';
                this.gameOverPanel.style.transform = 'translate(-50%, -50%)';
                this.gameOverPanel.style.zIndex = '1000';
                this.gameOverPanel.style.display = 'none';
                this.gameOverPanel.style.boxSizing = 'border-box';
                const goBase = '#C0C0C0';
                this.gameOverPanel.style.backgroundColor = goBase;
                this.gameOverPanel.style.borderTop = `4px solid ${UIObject.brightenColor(goBase, 80)}`;
                this.gameOverPanel.style.borderLeft = `4px solid ${UIObject.brightenColor(goBase, 80)}`;
                this.gameOverPanel.style.borderRight = `4px solid ${UIObject.brightenColor(goBase, -80)}`;
                this.gameOverPanel.style.borderBottom = `4px solid ${UIObject.brightenColor(goBase, -80)}`;

                this.gameOverTitle = document.createElement('div');
                this.gameOverTitle.textContent = T.gameOver;
                this.gameOverTitle.style.fontWeight = 'bold';
                this.gameOverTitle.style.fontFamily = 'Arial, sans-serif';
                this.gameOverTitle.style.color = '#FF0000';
                this.gameOverTitle.style.textAlign = 'center';
                this.gameOverPanel.appendChild(this.gameOverTitle);

                this.gameOverScore = document.createElement('div');
                this.gameOverScore.style.fontWeight = 'bold';
                this.gameOverScore.style.fontFamily = 'Arial, sans-serif';
                this.gameOverScore.style.color = '#000000';
                this.gameOverScore.style.textAlign = 'center';
                this.gameOverPanel.appendChild(this.gameOverScore);
            };

            // ── Жизненный цикл окна ──────────────────────────────────────────
            let built = false;
            const onFormDestroyed = (ev) => {
                if (ev.detail && ev.detail.form === appForm) {
                    game.stop();
                    window.removeEventListener('form-destroyed', onFormDestroyed);
                }
            };

            // Обработка клавиатуры (фреймворк вызывает onKeyPressed/onKeyReleased
            // на верхней по z-индексу форме).
            appForm.onKeyPressed = function (keyEvent) {
                if (game.isGameOver || game.isPaused) return;
                const key = keyEvent.key;
                if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(key)) {
                    keyEvent.preventDefault();
                    if (key === "ArrowDown" && !game.allowDownPress) return;
                    if (!game.keysPressed[key]) {
                        game.keysPressed[key] = true;
                        game.processKeyActions();
                        if (!game.moveInterval) {
                            game.moveInterval = setInterval(() => game.processKeyActions(), game.moveDelay);
                        }
                    }
                }
            };
            appForm.onKeyReleased = function (keyEvent) {
                if (game.isPaused) return;
                const key = keyEvent.key;
                if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(key)) {
                    game.keysPressed[key] = false;
                    if (key === 'ArrowDown') { game.dropHoldCount = 0; game.allowDownPress = true; }
                    if (!game.keysPressed['ArrowLeft'] && !game.keysPressed['ArrowRight'] && !game.keysPressed['ArrowDown']) {
                        if (game.moveInterval) { clearInterval(game.moveInterval); game.moveInterval = null; }
                    }
                }
            };
            appForm.onResizing = function () { game.reDraw(); };

            const instance = {
                appName: APP_NAME,
                form: appForm,

                onOpen: async (openParams) => {
                    if (built) {
                        // Повторное открытие из меню — просто активировать окно.
                        try {
                            if (typeof appForm.restore === 'function') appForm.restore();
                            else if (typeof appForm.activate === 'function') appForm.activate();
                        } catch (e) {}
                        return;
                    }
                    built = true;

                    appForm.getLayoutWithData = async () => ({ layout: [], data: [] });
                    await appForm.Draw();

                    const content = appForm.contentArea || (appForm.getContentArea && appForm.getContentArea());
                    if (!content) return;

                    game.buildUI(content);
                    window.addEventListener('form-destroyed', onFormDestroyed);

                    // Дать окну отрисоваться, затем посчитать размеры и стартовать.
                    setTimeout(() => {
                        game.reDraw();
                        game.newGame();
                    }, 50);
                },

                onAction: async () => false,

                destroy: () => {
                    game.stop();
                    window.removeEventListener('form-destroyed', onFormDestroyed);
                    try { appForm.close(); } catch (e) {}
                }
            };

            appForm.instance = instance;
            await instance.onOpen(params);
            return instance;
        }
    };

    if (window.MySpace) {
        window.MySpace.register(APP_NAME, descriptor);
    } else {
        console.error('[tetris] window.MySpace not found!');
    }
})();

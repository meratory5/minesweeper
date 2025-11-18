class Minesweeper {
    constructor() {
        // Preset settings
        this.presets = {
            'easy': { rows: 9, cols: 9, mines: 10 },
            'normal': { rows: 16, cols: 16, mines: 40 },
            'hard': { rows: 16, cols: 30, mines: 99 },
            'extreme': { rows: 50, cols: 50, mines: 500 }
        };
        this.presetOrder = ['easy', 'normal', 'hard', 'extreme'];
        this.currentPreset = 'easy';
        
        // Game settings
        const preset = this.presets[this.currentPreset];
        this.rows = preset.rows;
        this.cols = preset.cols;
        this.mines = preset.mines;
        this.cellSize = 40;
        this.scale = 1.0;
        this.offsetX = 0;
        this.offsetY = 0;
        
        // Game state
        this.firstClick = true;
        this.gameOver = false;
        this.board = null;
        this.revealed = null;
        this.flags = null;
        this.gameMessage = "";
        
        // Drag related
        this.dragging = false;
        this.dragStartPos = null;
        this.dragStartOffset = null;
        this.clickThreshold = 20;
        
        // Touch related
        this.touchStartTime = 0;
        this.touchStartPos = null;
        this.longPressTimer = null;
        this.longPressTriggered = false;
        this.longPressDuration = 500;
        this.pinchStartDistance = null;
        this.pinchStartScale = null;
        this.pinchCenter = null;
        
        // State
        this.state = "START";
        this.errorMessage = null;
        this.errorFromState = null;
        
        // DOM elements
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        this.initDOM();
        this.setupEventListeners();
        this.resizeCanvas();
        
        // Show initial screen
        this.showScreen('start-screen');
    }
    
    initDOM() {
        // Start screen
        document.getElementById('start-game-btn').onclick = () => this.startGame();
        document.getElementById('config-btn').onclick = () => this.showConfigScreen();
        document.getElementById('exit-btn').onclick = () => window.close();
        
        // Config screen
        document.getElementById('preset-btn').onclick = () => this.cyclePreset();
        document.getElementById('config-ok-btn').onclick = () => this.applyConfig();
        document.getElementById('config-cancel-btn').onclick = () => this.showScreen('start-screen');
        
        // Game over menu
        document.getElementById('restart-btn').onclick = () => this.restartGame();
        document.getElementById('new-game-btn').onclick = () => this.startGame();
        document.getElementById('return-title-btn').onclick = () => {
            this.showScreen('start-screen');
            document.getElementById('game-over-menu').classList.add('hidden');
            document.getElementById('game-message').classList.add('hidden');
        };
        document.getElementById('quit-btn').onclick = () => window.close();
        
        // Pause menu
        document.getElementById('resume-btn').onclick = () => this.resumeGame();
        document.getElementById('pause-restart-btn').onclick = () => {
            this.hidePauseMenu();
            this.restartGame();
        };
        document.getElementById('pause-new-game-btn').onclick = () => {
            this.hidePauseMenu();
            this.startGame();
        };
        document.getElementById('pause-return-btn').onclick = () => {
            this.hidePauseMenu();
            this.showScreen('start-screen');
        };
        document.getElementById('pause-quit-btn').onclick = () => window.close();
        
        // Error dialog
        document.getElementById('error-ok-btn').onclick = () => this.hideError();
    }
    
    setupEventListeners() {
        // Resize
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // Mouse events
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e));
        this.canvas.addEventListener('dragstart', (e) => e.preventDefault());
        
        // Touch events
        this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        this.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        
        // Keyboard events
        document.addEventListener('keydown', (e) => {
            if (this.state === 'GAME' && !this.gameOver && e.key === 'Escape') {
                this.showPauseMenu();
            }
        });
        
        // Input field events
        ['rows', 'cols', 'mines'].forEach(field => {
            const input = document.getElementById(`${field}-input`);
            input.addEventListener('input', () => {
                this.currentPreset = 'custom';
                this.updatePresetButton();
            });
        });
    }
    
    resizeCanvas() {
        // CSS size
        const displayWidth = window.innerWidth;
        const displayHeight = window.innerHeight;
        
        // Set canvas size same as CSS size (no DPI scaling)
        this.canvas.width = displayWidth;
        this.canvas.height = displayHeight;
        
        // CSS display size
        this.canvas.style.width = displayWidth + 'px';
        this.canvas.style.height = displayHeight + 'px';
        
        if (this.state === 'GAME') {
            this.enforceViewLimits();
            this.drawGame();
        }
    }
    
    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById(screenId).classList.remove('hidden');
        
        if (screenId === 'start-screen') {
            this.state = 'START';
        } else if (screenId === 'config-screen') {
            this.state = 'CONFIG';
        } else if (screenId === 'game-screen') {
            this.state = 'GAME';
        }
    }
    
    showConfigScreen() {
        const preset = this.presets[this.currentPreset];
        document.getElementById('rows-input').value = preset.rows;
        document.getElementById('cols-input').value = preset.cols;
        document.getElementById('mines-input').value = preset.mines;
        this.updatePresetButton();
        this.showScreen('config-screen');
    }
    
    cyclePreset() {
        if (this.currentPreset === 'custom') {
            this.currentPreset = this.presetOrder[0];
        } else {
            const currentIdx = this.presetOrder.indexOf(this.currentPreset);
            const nextIdx = (currentIdx + 1) % this.presetOrder.length;
            this.currentPreset = this.presetOrder[nextIdx];
        }
        
        const preset = this.presets[this.currentPreset];
        document.getElementById('rows-input').value = preset.rows;
        document.getElementById('cols-input').value = preset.cols;
        document.getElementById('mines-input').value = preset.mines;
        this.updatePresetButton();
    }
    
    updatePresetButton() {
        const btn = document.getElementById('preset-btn');
        if (this.currentPreset === 'custom') {
            btn.textContent = 'CUSTOM';
            btn.classList.add('custom');
        } else {
            btn.textContent = this.currentPreset.toUpperCase();
            btn.classList.remove('custom');
        }
    }
    
    applyConfig() {
        const rows = parseInt(document.getElementById('rows-input').value);
        const cols = parseInt(document.getElementById('cols-input').value);
        const mines = parseInt(document.getElementById('mines-input').value);
        
        if (isNaN(rows) || isNaN(cols) || isNaN(mines)) {
            this.showError("Invalid input.\nPlease enter numbers only.", 'CONFIG');
            return;
        }
        
        if (rows < 4 || rows > 100 || cols < 4 || cols > 100) {
            this.showError("Rows and Cols must be\nbetween 4 and 100", 'CONFIG');
            return;
        }
        
        const maxMines = rows * cols - 9;
        if (mines < 1 || mines > maxMines) {
            this.showError(`Mines must be\nbetween 1 and ${maxMines}`, 'CONFIG');
            return;
        }
        
        this.rows = rows;
        this.cols = cols;
        this.mines = mines;
        this.showScreen('start-screen');
    }
    
    showError(message, fromState) {
        this.errorMessage = message;
        this.errorFromState = fromState;
        document.getElementById('error-message').textContent = message;
        document.getElementById('error-overlay').classList.remove('hidden');
    }
    
    hideError() {
        document.getElementById('error-overlay').classList.add('hidden');
        this.errorMessage = null;
        if (this.errorFromState) {
            this.state = this.errorFromState;
            this.errorFromState = null;
        }
    }
    
    startGame() {
        this.firstClick = true;
        this.gameOver = false;
        this.gameMessage = "";
        this.board = this.createInitialBoard();
        this.revealed = Array(this.rows).fill().map(() => Array(this.cols).fill(false));
        this.flags = Array(this.rows).fill().map(() => Array(this.cols).fill(false));
        this.resetViewToDefault();
        this.showScreen('game-screen');
        document.getElementById('game-over-menu').classList.add('hidden');
        document.getElementById('game-message').classList.add('hidden');
        this.drawGame();
    }
    
    restartGame() {
        if (this.board) {
            this.revealed = Array(this.rows).fill().map(() => Array(this.cols).fill(false));
            this.flags = Array(this.rows).fill().map(() => Array(this.cols).fill(false));
            this.gameOver = false;
            this.gameMessage = "";
            this.firstClick = false;
            this.resetViewToDefault();
            document.getElementById('game-over-menu').classList.add('hidden');
            document.getElementById('game-message').classList.add('hidden');
            this.drawGame();
        }
    }
    
    createInitialBoard() {
        return Array(this.rows).fill().map(() => Array(this.cols).fill(''));
    }
    
    resetViewToDefault() {
        // Calculate ratio of board size to screen size
        const scaleX = this.canvas.width / (this.cols * this.cellSize);
        const scaleY = this.canvas.height / (this.rows * this.cellSize);
        
        // Use smaller ratio to fit on screen (0.9x for margin)
        this.scale = Math.min(scaleX, scaleY) * 0.9;
        
        // Center the board
        const boardW = this.cols * this.cellSize * this.scale;
        const boardH = this.rows * this.cellSize * this.scale;
        this.offsetX = (this.canvas.width - boardW) / 2;
        this.offsetY = (this.canvas.height - boardH) / 2;
    }
    
    enforceViewLimits() {
        const minScaleX = (this.canvas.width / 3) / (this.cols * this.cellSize);
        const minScaleY = (this.canvas.height / 3) / (this.rows * this.cellSize);
        const minScale = Math.min(minScaleX, minScaleY);
        
        if (this.scale < minScale) {
            this.scale = minScale;
        }
        
        const boardW = this.cols * this.cellSize * this.scale;
        const boardH = this.rows * this.cellSize * this.scale;
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;
        
        // Prevent right edge from going left of center
        if (this.offsetX > centerX) this.offsetX = centerX;
        // Prevent left edge from going right of center
        if (this.offsetX + boardW < centerX) this.offsetX = centerX - boardW;
        // Prevent bottom edge from going above center
        if (this.offsetY > centerY) this.offsetY = centerY;
        // Prevent top edge from going below center
        if (this.offsetY + boardH < centerY) this.offsetY = centerY - boardH;
    }
    
    getCanvasCoordinates(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }
    
    onMouseDown(e) {
        if (this.gameOver) return;
        
        const coords = this.getCanvasCoordinates(e.clientX, e.clientY);
        
        if (e.button === 0) {
            this.dragStartPos = coords;
            this.dragStartOffset = { x: this.offsetX, y: this.offsetY };
            this.dragging = false;
            
            // Set long press timer
            this.longPressTriggered = false;
            this.longPressTimer = setTimeout(() => {
                if (!this.dragging && this.dragStartPos) {
                    this.longPressTriggered = true;
                    this.rightClick(coords.x, coords.y);
                }
            }, this.longPressDuration);
        } else if (e.button === 2) {
            this.rightClick(coords.x, coords.y);
        }
    }
    
    onMouseMove(e) {
        if (this.gameOver || !this.dragStartPos) return;
        
        const coords = this.getCanvasCoordinates(e.clientX, e.clientY);
        const dx = coords.x - this.dragStartPos.x;
        const dy = coords.y - this.dragStartPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (this.dragging) {
            this.offsetX = this.dragStartOffset.x + dx;
            this.offsetY = this.dragStartOffset.y + dy;
            this.enforceViewLimits();
            this.drawGame();
        } else if (distance > this.clickThreshold) {
            // Cancel long press timer when drag is detected
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
            this.dragging = true;
            this.canvas.classList.add('dragging');
        }
    }
    
    onMouseUp(e) {
        if (this.gameOver) return;
        
        // Clear long press timer
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        
        if (e.button === 0 && this.dragStartPos) {
            if (!this.dragging && !this.longPressTriggered) {
                const coords = this.getCanvasCoordinates(e.clientX, e.clientY);
                this.leftClick(coords.x, coords.y);
            }
            this.canvas.classList.remove('dragging');
            this.dragStartPos = null;
            this.dragStartOffset = null;
            this.dragging = false;
            this.longPressTriggered = false;
        }
    }
    
    onWheel(e) {
        e.preventDefault();
        
        const coords = this.getCanvasCoordinates(e.clientX, e.clientY);
        
        if (e.ctrlKey) {
            this.offsetY += e.deltaY > 0 ? -10 : 10;
        } else if (e.shiftKey) {
            this.offsetX += e.deltaY > 0 ? -10 : 10;
        } else {
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const newScale = this.scale * factor;
            
            const minScaleX = (this.canvas.width / 3) / (this.cols * this.cellSize);
            const minScaleY = (this.canvas.height / 3) / (this.rows * this.cellSize);
            const minScale = Math.min(minScaleX, minScaleY);
            
            const maxScaleX = (this.canvas.width / 3) / this.cellSize;
            const maxScaleY = (this.canvas.height / 3) / this.cellSize;
            const maxScale = Math.min(maxScaleX, maxScaleY);
            
            if (newScale < minScale) {
                this.scale = minScale;
            } else if (newScale > maxScale) {
                this.scale = maxScale;
            } else {
                const mx = coords.x;
                const my = coords.y;
                this.offsetX = mx - (mx - this.offsetX) * factor;
                this.offsetY = my - (my - this.offsetY) * factor;
                this.scale = newScale;
            }
        }
        
        this.enforceViewLimits();
        this.drawGame();
    }
    
    onTouchStart(e) {
        e.preventDefault();
        if (this.gameOver) return;
        
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            const coords = this.getCanvasCoordinates(touch.clientX, touch.clientY);
            this.touchStartTime = Date.now();
            this.touchStartPos = coords;
            this.dragStartPos = coords;
            this.dragStartOffset = { x: this.offsetX, y: this.offsetY };
            this.dragging = false;
            this.longPressTriggered = false;
            
            // Set long press timer
            this.longPressTimer = setTimeout(() => {
                if (!this.dragging && this.touchStartPos) {
                    this.longPressTriggered = true;
                    this.rightClick(this.touchStartPos.x, this.touchStartPos.y);
                    if (navigator.vibrate) {
                        navigator.vibrate(50);
                    }
                }
            }, this.longPressDuration);
        } else if (e.touches.length === 2) {
            // Two finger touch: start pinch zoom
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
            this.dragging = false;
            this.touchStartPos = null;
            
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            const coords1 = this.getCanvasCoordinates(touch1.clientX, touch1.clientY);
            const coords2 = this.getCanvasCoordinates(touch2.clientX, touch2.clientY);
            const dx = coords2.x - coords1.x;
            const dy = coords2.y - coords1.y;
            this.pinchStartDistance = Math.sqrt(dx * dx + dy * dy);
            this.pinchStartScale = this.scale;
            this.pinchCenter = {
                x: (coords1.x + coords2.x) / 2,
                y: (coords1.y + coords2.y) / 2
            };
        }
    }
    
    onTouchMove(e) {
        e.preventDefault();
        if (this.gameOver) return;
        
        if (e.touches.length === 1 && this.touchStartPos) {
            const touch = e.touches[0];
            const coords = this.getCanvasCoordinates(touch.clientX, touch.clientY);
            const dx = coords.x - this.dragStartPos.x;
            const dy = coords.y - this.dragStartPos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (this.dragging) {
                this.offsetX = this.dragStartOffset.x + dx;
                this.offsetY = this.dragStartOffset.y + dy;
                this.enforceViewLimits();
                this.drawGame();
            } else if (distance > this.clickThreshold) {
                // Cancel long press timer when drag is detected
                if (this.longPressTimer) {
                    clearTimeout(this.longPressTimer);
                    this.longPressTimer = null;
                }
                this.dragging = true;
                this.canvas.classList.add('dragging');
            }
        } else if (e.touches.length === 2 && this.pinchStartDistance !== null) {
            // Two finger touch: pinch zoom
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            const coords1 = this.getCanvasCoordinates(touch1.clientX, touch1.clientY);
            const coords2 = this.getCanvasCoordinates(touch2.clientX, touch2.clientY);
            const dx = coords2.x - coords1.x;
            const dy = coords2.y - coords1.y;
            const currentDistance = Math.sqrt(dx * dx + dy * dy);
            
            const scaleFactor = currentDistance / this.pinchStartDistance;
            const newScale = this.pinchStartScale * scaleFactor;
            
            const minScaleX = (this.canvas.width / 3) / (this.cols * this.cellSize);
            const minScaleY = (this.canvas.height / 3) / (this.rows * this.cellSize);
            const minScale = Math.min(minScaleX, minScaleY);
            
            const maxScaleX = (this.canvas.width / 3) / this.cellSize;
            const maxScaleY = (this.canvas.height / 3) / this.cellSize;
            const maxScale = Math.min(maxScaleX, maxScaleY);
            
            if (newScale >= minScale && newScale <= maxScale) {
                // Zoom based on pinch center (center point is fixed)
                const centerX = this.pinchCenter.x;
                const centerY = this.pinchCenter.y;
                
                this.offsetX = centerX - (centerX - this.offsetX) * (newScale / this.scale);
                this.offsetY = centerY - (centerY - this.offsetY) * (newScale / this.scale);
                this.scale = newScale;
                
                this.enforceViewLimits();
                this.drawGame();
            }
        }
    }
    
    onTouchEnd(e) {
        e.preventDefault();
        if (this.gameOver) return;
        
        // Clear long press timer
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        
        if (e.touches.length === 0) {
            // All fingers released
            if (this.touchStartPos && !this.dragging && !this.longPressTriggered) {
                // Normal tap (equivalent to left click)
                this.leftClick(this.touchStartPos.x, this.touchStartPos.y);
            }
            
            this.canvas.classList.remove('dragging');
            this.touchStartPos = null;
            this.dragStartPos = null;
            this.dragStartOffset = null;
            this.dragging = false;
            this.longPressTriggered = false;
            this.pinchStartDistance = null;
            this.pinchStartScale = null;
        } else if (e.touches.length === 1) {
            // From two fingers to one finger
            this.pinchStartDistance = null;
            this.pinchStartScale = null;
        }
    }
    
    leftClick(x, y) {
        if (this.gameOver) return;
        
        const cell = this.getCellFromMouse(x, y);
        if (!cell) return;
        
        const { r, c } = cell;
        
        if (this.firstClick) {
            this.board = this.createBoardSafeFirst(r, c);
            this.firstClick = false;
        }
        
        this.revealCell(r, c);
        
        if (!this.gameOver && this.checkWin()) {
            this.gameOver = true;
            this.gameMessage = "Victory!";
            this.showGameOverMenu(true);
        }
        
        this.drawGame();
    }
    
    rightClick(x, y) {
        if (this.firstClick || this.gameOver) return;
        
        const cell = this.getCellFromMouse(x, y);
        if (!cell) return;
        
        const { r, c } = cell;
        
        if (this.revealed[r][c]) return;
        
        this.flags[r][c] = !this.flags[r][c];
        this.drawGame();
    }
    
    getCellFromMouse(x, y) {
        const cellX = (x - this.offsetX) / (this.cellSize * this.scale);
        const cellY = (y - this.offsetY) / (this.cellSize * this.scale);
        const c = Math.floor(cellX);
        const r = Math.floor(cellY);
        
        if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
            return { r, c };
        }
        return null;
    }
    
    createBoardSafeFirst(firstR, firstC) {
        const board = Array(this.rows).fill().map(() => Array(this.cols).fill(''));
        
        let allPositions = [];
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                allPositions.push({ r, c });
            }
        }
        
        const safeArea = [];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const nr = firstR + dr;
                const nc = firstC + dc;
                if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
                    safeArea.push({ r: nr, c: nc });
                }
            }
        }
        
        allPositions = allPositions.filter(pos => 
            !safeArea.some(safe => safe.r === pos.r && safe.c === pos.c)
        );
        
        const minePositions = [];
        for (let i = 0; i < this.mines; i++) {
            const idx = Math.floor(Math.random() * allPositions.length);
            minePositions.push(allPositions[idx]);
            allPositions.splice(idx, 1);
        }
        
        for (const { r, c } of minePositions) {
            board[r][c] = 'M';
        }
        
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (board[r][c] === 'M') continue;
                
                let count = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const nr = r + dr;
                        const nc = c + dc;
                        if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols && board[nr][nc] === 'M') {
                            count++;
                        }
                    }
                }
                board[r][c] = count.toString();
            }
        }
        
        return board;
    }
    
    revealCell(r, c) {
        const stack = [{ r, c }];
        
        while (stack.length > 0) {
            const { r, c } = stack.pop();
            
            if (this.revealed[r][c] || this.flags[r][c]) continue;
            
            this.revealed[r][c] = true;
            
            if (this.board[r][c] === 'M') {
                this.gameOver = true;
                this.gameMessage = "Game Over!";
                this.showAll();
                this.showGameOverMenu(false);
                return;
            }
            
            if (this.board[r][c] === '0') {
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const nr = r + dr;
                        const nc = c + dc;
                        if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols && !this.revealed[nr][nc]) {
                            stack.push({ r: nr, c: nc });
                        }
                    }
                }
            }
        }
    }
    
    checkWin() {
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (this.board[r][c] !== 'M' && !this.revealed[r][c]) {
                    return false;
                }
            }
        }
        return true;
    }
    
    showAll() {
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                this.revealed[r][c] = true;
            }
        }
    }
    
    showGameOverMenu(victory) {
        const messageEl = document.getElementById('game-message');
        messageEl.textContent = this.gameMessage;
        messageEl.className = victory ? 'victory' : 'game-over';
        messageEl.classList.remove('hidden');
        
        const menuEl = document.getElementById('game-over-menu');
        
        if (victory) {
            document.getElementById('restart-btn').style.display = 'none';
        } else {
            document.getElementById('restart-btn').style.display = 'block';
        }
        
        menuEl.classList.remove('hidden');
    }
    
    showPauseMenu() {
        document.getElementById('pause-overlay').classList.remove('hidden');
    }
    
    hidePauseMenu() {
        document.getElementById('pause-overlay').classList.add('hidden');
    }
    
    resumeGame() {
        this.hidePauseMenu();
    }
    
    drawGame() {
        if (!this.board) return;
        
        // Clear and redraw
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        const scaleSize = this.cellSize * this.scale;
        
        const startCol = Math.max(0, Math.floor(-this.offsetX / scaleSize));
        const endCol = Math.min(this.cols, Math.floor((this.canvas.width - this.offsetX) / scaleSize) + 2);
        const startRow = Math.max(0, Math.floor(-this.offsetY / scaleSize));
        const endRow = Math.min(this.rows, Math.floor((this.canvas.height - this.offsetY) / scaleSize) + 2);
        
        // Fill cells
        for (let r = startRow; r < endRow; r++) {
            for (let c = startCol; c < endCol; c++) {
                const x = this.offsetX + c * scaleSize;
                const y = this.offsetY + r * scaleSize;
                
                this.ctx.fillStyle = this.revealed[r][c] ? '#ffffff' : '#add8e6';
                this.ctx.fillRect(x, y, scaleSize, scaleSize);
            }
        }
        
        // Grid lines
        this.ctx.strokeStyle = '#000000';
        this.ctx.lineWidth = 1;
        
        const boardTop = this.offsetY;
        const boardBottom = this.offsetY + this.rows * scaleSize;
        for (let c = startCol; c <= endCol; c++) {
            const x = this.offsetX + c * scaleSize;
            this.ctx.beginPath();
            this.ctx.moveTo(x, boardTop);
            this.ctx.lineTo(x, boardBottom);
            this.ctx.stroke();
        }
        
        const boardLeft = this.offsetX;
        const boardRight = this.offsetX + this.cols * scaleSize;
        for (let r = startRow; r <= endRow; r++) {
            const y = this.offsetY + r * scaleSize;
            this.ctx.beginPath();
            this.ctx.moveTo(boardLeft, y);
            this.ctx.lineTo(boardRight, y);
            this.ctx.stroke();
        }
        
        // Text
        const fontSize = Math.max(16, Math.floor(24 * this.scale));
        this.ctx.font = `${fontSize}px Arial`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        
        for (let r = startRow; r < endRow; r++) {
            for (let c = startCol; c < endCol; c++) {
                const x = this.offsetX + c * scaleSize + scaleSize / 2;
                const y = this.offsetY + r * scaleSize + scaleSize / 2;
                
                if (this.revealed[r][c]) {
                    const val = this.board[r][c];
                    if (val !== '0') {
                        if (val === 'M') {
                            this.ctx.fillStyle = '#000000';
                            this.ctx.fillText('💣', x, y);
                        } else {
                            this.ctx.fillStyle = '#000000';
                            this.ctx.fillText(val, x, y);
                        }
                    }
                } else if (this.flags[r][c]) {
                    this.ctx.fillStyle = '#000000';
                    this.ctx.fillText('🚩', x, y);
                }
            }
        }
        
        // Game over overlay
        if (this.gameOver) {
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }
}

// Start game
const game = new Minesweeper();
class Minesweeper {
    constructor() {
        // プリセット
        this.presets = {
            'easy': { rows: 9, cols: 9, mines: 10 },
            'normal': { rows: 16, cols: 16, mines: 40 },
            'hard': { rows: 16, cols: 30, mines: 99 },
            'extreme': { rows: 50, cols: 50, mines: 500 }
        };
        this.presetOrder = ['easy', 'normal', 'hard', 'extreme'];
        this.currentPreset = 'easy';
        
        // ゲーム設定
        const preset = this.presets[this.currentPreset];
        this.rows = preset.rows;
        this.cols = preset.cols;
        this.mines = preset.mines;
        this.cellSize = 40;
        this.scale = 1.0;
        this.offsetX = 0;
        this.offsetY = 0;
        
        // ゲーム状態
        this.firstClick = true;
        this.gameOver = false;
        this.board = null;
        this.revealed = null;
        this.flags = null;
        this.gameMessage = "";
        
        // ドラッグ関連
        this.dragging = false;
        this.dragStartPos = null;
        this.dragStartOffset = null;
        this.clickThreshold = 20;
        
        // タッチ関連
        this.touchStartTime = 0;
        this.touchStartPos = null;
        this.longPressTimer = null;
        this.longPressTriggered = false;
        this.longPressDuration = 500; // 500ms
        
        // 状態
        this.state = "START";
        this.errorMessage = null;
        this.errorFromState = null;
        
        // DOM要素
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        this.initDOM();
        this.setupEventListeners();
        this.resizeCanvas();
        
        // 初期画面を表示
        this.showScreen('start-screen');
    }
    
    initDOM() {
        // スタート画面
        document.getElementById('start-game-btn').onclick = () => this.startGame();
        document.getElementById('config-btn').onclick = () => this.showConfigScreen();
        document.getElementById('exit-btn').onclick = () => window.close();
        
        // 設定画面
        document.getElementById('preset-btn').onclick = () => this.cyclePreset();
        document.getElementById('config-ok-btn').onclick = () => this.applyConfig();
        document.getElementById('config-cancel-btn').onclick = () => this.showScreen('start-screen');
        
        // ゲームオーバーメニュー
        document.getElementById('restart-btn').onclick = () => this.restartGame();
        document.getElementById('new-game-btn').onclick = () => this.startGame();
        document.getElementById('return-title-btn').onclick = () => {
            this.showScreen('start-screen');
            document.getElementById('game-over-menu').classList.add('hidden');
            document.getElementById('game-message').classList.add('hidden');
        };
        document.getElementById('quit-btn').onclick = () => window.close();
        
        // ポーズメニュー
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
        
        // エラーダイアログ
        document.getElementById('error-ok-btn').onclick = () => this.hideError();
    }
    
    setupEventListeners() {
        // リサイズ
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // マウスイベント
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e));
        this.canvas.addEventListener('dragstart', (e) => e.preventDefault()); // この行を追加
        
        // タッチイベント
        this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        this.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        
        // キーボードイベント
        document.addEventListener('keydown', (e) => {
            if (this.state === 'GAME' && !this.gameOver && e.key === 'Escape') {
                this.showPauseMenu();
            }
        });
        
        // 入力フィールドイベント
        ['rows', 'cols', 'mines'].forEach(field => {
            const input = document.getElementById(`${field}-input`);
            input.addEventListener('input', () => {
                this.currentPreset = 'custom';
                this.updatePresetButton();
            });
        });
    }
    
    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
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
        const scaleX = this.canvas.width / (this.cols * this.cellSize);
        const scaleY = this.canvas.height / (this.rows * this.cellSize);
        this.scale = Math.min(scaleX, scaleY) * 0.9;
        
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
        
        if (this.offsetX > centerX) this.offsetX = centerX;
        if (this.offsetX + boardW < centerX) this.offsetX = centerX - boardW;
        if (this.offsetY > centerY) this.offsetY = centerY;
        if (this.offsetY + boardH < centerY) this.offsetY = centerY - boardH;
    }
    
    onMouseDown(e) {
        if (this.gameOver) return;
        
        if (e.button === 0) {
            this.dragStartPos = { x: e.clientX, y: e.clientY };
            this.dragStartOffset = { x: this.offsetX, y: this.offsetY };
            this.dragging = false;
        } else if (e.button === 2) {
            this.rightClick(e.clientX, e.clientY);
        }
    }
    
    onMouseMove(e) {
        if (this.gameOver || !this.dragStartPos) return;
        
        const dx = e.clientX - this.dragStartPos.x;
        const dy = e.clientY - this.dragStartPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (this.dragging) {
            this.offsetX = this.dragStartOffset.x + dx;
            this.offsetY = this.dragStartOffset.y + dy;
            this.enforceViewLimits();
            this.drawGame();
        } else if (distance > this.clickThreshold) {
            this.dragging = true;
            this.canvas.classList.add('dragging');
            this.dragStartPos = { x: e.clientX, y: e.clientY };
        }
    }
    
    onMouseUp(e) {
        if (this.gameOver) return;
        
        if (e.button === 0 && this.dragStartPos) {
            if (!this.dragging) {
                this.leftClick(e.clientX, e.clientY);
            }
            this.canvas.classList.remove('dragging');
            this.dragStartPos = null;
            this.dragStartOffset = null;
            this.dragging = false;
        }
    }
    
    onWheel(e) {
        e.preventDefault();
        
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
                const mx = e.clientX;
                const my = e.clientY;
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
        if (this.gameOver || e.touches.length !== 1) return;
        
        const touch = e.touches[0];
        this.touchStartTime = Date.now();
        this.touchStartPos = { x: touch.clientX, y: touch.clientY };
        this.dragStartPos = { x: touch.clientX, y: touch.clientY };
        this.dragStartOffset = { x: this.offsetX, y: this.offsetY };
        this.dragging = false;
        this.longPressTriggered = false;
        
        // 長押しタイマーを設定
        this.longPressTimer = setTimeout(() => {
            if (!this.dragging && this.touchStartPos) {
                this.longPressTriggered = true;
                this.rightClick(this.touchStartPos.x, this.touchStartPos.y);
                // 軽い振動フィードバック(対応端末のみ)
                if (navigator.vibrate) {
                    navigator.vibrate(50);
                }
            }
        }, this.longPressDuration);
    }
    
    onTouchMove(e) {
        e.preventDefault();
        if (this.gameOver || !this.touchStartPos || e.touches.length !== 1) return;
        
        const touch = e.touches[0];
        const dx = touch.clientX - this.dragStartPos.x;
        const dy = touch.clientY - this.dragStartPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (this.dragging) {
            this.offsetX = this.dragStartOffset.x + dx;
            this.offsetY = this.dragStartOffset.y + dy;
            this.enforceViewLimits();
            this.drawGame();
        } else if (distance > this.clickThreshold) {
            // ドラッグと判定したら長押しタイマーをキャンセル
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
            this.dragging = true;
            this.canvas.classList.add('dragging');
            this.dragStartPos = { x: touch.clientX, y: touch.clientY };
        }
    }
    
    onTouchEnd(e) {
        e.preventDefault();
        if (this.gameOver) return;
        
        // 長押しタイマーをクリア
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        
        if (this.touchStartPos && !this.dragging && !this.longPressTriggered) {
            // 通常のタップ(左クリック相当)
            this.leftClick(this.touchStartPos.x, this.touchStartPos.y);
        }
        
        this.canvas.classList.remove('dragging');
        this.touchStartPos = null;
        this.dragStartPos = null;
        this.dragStartOffset = null;
        this.dragging = false;
        this.longPressTriggered = false;
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
        
        // 一度クリアしてから描画
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        const scaleSize = this.cellSize * this.scale;
        
        const startCol = Math.max(0, Math.floor(-this.offsetX / scaleSize));
        const endCol = Math.min(this.cols, Math.floor((this.canvas.width - this.offsetX) / scaleSize) + 2);
        const startRow = Math.max(0, Math.floor(-this.offsetY / scaleSize));
        const endRow = Math.min(this.rows, Math.floor((this.canvas.height - this.offsetY) / scaleSize) + 2);
        
        // セルの塗りつぶし
        for (let r = startRow; r < endRow; r++) {
            for (let c = startCol; c < endCol; c++) {
                const x = this.offsetX + c * scaleSize;
                const y = this.offsetY + r * scaleSize;
                
                this.ctx.fillStyle = this.revealed[r][c] ? '#ffffff' : '#add8e6';
                this.ctx.fillRect(x, y, scaleSize, scaleSize);
            }
        }
        
        // グリッド線
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
        
        // テキスト
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
        
        // ゲームオーバーオーバーレイ
        if (this.gameOver) {
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }
}

// ゲーム開始
const game = new Minesweeper();
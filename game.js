'use strict';
/* ================= 主程序：多人模式 / 主循环 / 相机 / 网络会话 / HUD =================
 * 模式：
 *   bot        单人混战（本地模拟，玩家 + 2 个机器人）
 *   net-host   网络对战·房主（权威模拟所有机甲，广播快照）
 *   net-client 网络对战·访客（发送输入，应用快照）
 *
 * 多人对战：一个房间最多 MAX_PLAYERS 名玩家大乱斗，存活到最后者获胜。
 * 地图由房主生成的种子决定，所有端生成完全一致的随机地图。
 */

const BOT_COUNT = 2;   // 单人模式的机器人数量

class App {
  constructor() {
    this.canvas = document.getElementById('game');
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.localInput = new LocalInput();
    this.bots = new Map();    // id → Bot

    this.mode = null;         // bot | net-host | net-client
    this.state = 'menu';      // menu | wait | fight | ko
    this.myId = genId();
    this.link = null;
    this.room = '';
    this.lobby = [];          // [{id,name}]（第一个是房主）
    this.players = [];        // 本局参战 [{id,name}]
    this.mechs = [];
    this.remoteInp = new Map();  // id → {l,r,b,j,a,ts}
    this.pending = { j: false, a: false };
    this._lastInp = null;
    this.sendAcc = 0; this.lastMsg = 0; this._lastPing = 0;
    this.lastSeen = new Map();  // id → 最后消息时刻（房主判定玩家在线）
    this.winner = null; this.koTimer = 0; this.joinTimer = 0;
    this.cam = { x: 0, y: 0 };
    this.shake = 0; this.time = 0;

    this.$ = (id) => document.getElementById(id);
    this.dom = {
      hpMe: this.$('hp-me'),
      nameMe: this.$('name-me'),
      wepMe: this.$('wep-me'), buffMe: this.$('buff-me'),
      roomTag: this.$('room-tag'),
      others: this.$('others'),
      announce: this.$('announce'),
      ko: this.$('ko'), koText: this.$('ko-text'), koSub: this.$('ko-sub'), btnRematch: this.$('btn-rematch'),
      menu: this.$('menu'), netStatus: this.$('net-status'),
      roomInput: this.$('room-input'),
      lobby: this.$('lobby'), lobbyList: this.$('lobby-list'), lobbyHint: this.$('lobby-hint'),
      btnStart: this.$('btn-start'),
      shareBox: this.$('share-box'), shareUrl: this.$('share-url'), btnCopy: this.$('btn-copy'),
      toast: this.$('toast'),
      skillPick: this.$('skill-pick'), skillCards: this.$('skill-cards'),
      skillTimerFill: this.$('skill-timer-fill'), skillWaitHint: this.$('skill-wait-hint'),
      bgmBar: this.$('bgm-bar'), bgmInput: this.$('bgm-input'),
      btnBgmPlay: this.$('btn-bgm-play'), btnBgmStop: this.$('btn-bgm-stop'),
      bgmInputLocal: this.$('bgm-input-local'),
      btnBgmPlayLocal: this.$('btn-bgm-play-local'), btnBgmStopLocal: this.$('btn-bgm-stop-local'),
      bgmFile: this.$('bgm-file'), btnBgmFile: this.$('btn-bgm-file'),
      bgmFileLocal: this.$('bgm-file-local'), btnBgmFileLocal: this.$('btn-bgm-file-local'),
      bgmNow: this.$('bgm-now'), bgmNowText: this.$('bgm-now-text'),
      btnBgmMute: this.$('btn-bgm-mute'),
    };

    /* 技能选择状态 */
    this.skillState = null;    // null | 'pick' | 'wait'
    this.skillChoices = [];     // 当前3张卡 [skillId, skillId, skillId]
    this.skillPicked = null;    // 已选技能ID
    this.skillTimer = 0;        // 选择倒计时
    this.playerSkills = {};    // { playerId: skillId } — 所有玩家选择结果
    this.skillSeed = 0;         // 技能卡种子（房主生成，同步到各端）

    /* BGM 背景音乐：房主设置 URL → 广播给所有客户端播放；房间解散时停止 */
    this.bgmUrl = '';
    this.bgmPlaying = false;
    this.bgmMuted = false;
    this.bgmAudio = new Audio();
    this.bgmAudio.loop = true;
    this.bgmAudio.volume = 0.4;
    this.bgmAudio.preload = 'auto';
    this.bgmAudio.addEventListener('error', () => this._onBgmError());
    this.bgmObjectUrl = '';   // 本地文件播放时创建的 blob URL（需手动释放）

    /* 初始场景（作为菜单背景，用随机地图展示） */
    this.fx = new FX();
    this.world = new World(this, new GameMap((Math.random() * 1e9) | 0));

    this.bindMenu();
    this.resize();
    addEventListener('resize', () => this.resize());

    /* 自动进入房间（核心体验：网址即房间，无需手动点按钮）：
     * - 本地文件打开（file://）→ 不启动联机，直接进菜单，单人模式可玩
     * - URL 带 ?room=XXXX → 加入该房间（分享链接场景）
     * - URL 不带 room → 自动创建新房间，并用 history.replaceState 把 URL 改写为
     *   带 ?room=XXXX 的形式（不重载页面），这样当前玩家复制地址栏 URL 就能分享。
     * 单人模式仍保留为独立入口（按钮启动）。 */
    if (IS_LOCAL_FILE) {
      this.applyLocalMode();
    } else {
      const initRoom = (new URLSearchParams(location.search).get('room') || '').trim().toUpperCase();
      if (/^[A-Z0-9]{4}$/.test(initRoom)) {
        this.dom.roomInput.value = initRoom;
        this.toast('通过链接加入房间 ' + initRoom);
        this.startJoin();
      } else {
        /* 自动创建房间并改写地址栏 URL（用户复制链接发给朋友即可联机） */
        this.startHost(true);   // true = 自动模式：建完房后改写 URL
      }
    }

    /* 网络心跳：墙钟驱动（后台标签页 rAF 被节流停摆时仍以 ≥1Hz 运转，
     * 保证输入流与保活 ping 不断，防止短暂切页被误判掉线） */
    setInterval(() => this.netPump(), 120);

    this.last = performance.now();
    requestAnimationFrame((n) => this.loop(n));
  }

  /* ---------- 视口 ---------- */
  resize() {
    const box = document.getElementById('stage').getBoundingClientRect();
    const aspect = Math.max(0.4, Math.min(3.2, box.width / Math.max(1, box.height)));
    VIEW_W = clamp(Math.round(VIEW_H * aspect), 160, 640);
    this.canvas.width = VIEW_W;
    this.canvas.height = VIEW_H;
    this.ctx.imageSmoothingEnabled = false;
  }

  me() { return this.mechs.find((m) => m.id === this.myId) || null; }
  others() { return this.mechs.filter((m) => m.id !== this.myId); }

  /* ---------- 菜单 ---------- */
  bindMenu() {
    this.$('btn-bot').addEventListener('click', () => this.startBot());
    this.$('btn-host').addEventListener('click', () => this.startHost());
    this.$('btn-join').addEventListener('click', () => this.startJoin());
    this.$('btn-cancel-net').addEventListener('click', () => this.backToMenu());
    this.$('btn-rematch').addEventListener('click', () => this.tryRematch());
    this.$('btn-menu').addEventListener('click', () => this.backToMenu());
    this.dom.btnStart.addEventListener('click', () => this.hostStart());
    if (this.dom.btnCopy) this.dom.btnCopy.addEventListener('click', () => this.copyShare());
    /* BGM 控制 */
    if (this.dom.btnBgmPlay) this.dom.btnBgmPlay.addEventListener('click', () => this.onBgmPlay());
    if (this.dom.btnBgmStop) this.dom.btnBgmStop.addEventListener('click', () => this.onBgmStop());
    if (this.dom.btnBgmMute) this.dom.btnBgmMute.addEventListener('click', () => this.toggleBgmMute());
    /* 单人模式：菜单内的本地 BGM 栏 */
    if (this.dom.btnBgmPlayLocal) this.dom.btnBgmPlayLocal.addEventListener('click', () => this.onBgmPlay(true));
    if (this.dom.btnBgmStopLocal) this.dom.btnBgmStopLocal.addEventListener('click', () => this.onBgmStop());
    /* 选择本地音频文件 */
    if (this.dom.btnBgmFile) this.dom.btnBgmFile.addEventListener('click', () => this.dom.bgmFile.click());
    if (this.dom.bgmFile) this.dom.bgmFile.addEventListener('change', () => this.onBgmFile(this.dom.bgmFile, false));
    if (this.dom.btnBgmFileLocal) this.dom.btnBgmFileLocal.addEventListener('click', () => this.dom.bgmFileLocal.click());
    if (this.dom.bgmFileLocal) this.dom.bgmFileLocal.addEventListener('change', () => this.onBgmFile(this.dom.bgmFileLocal, true));
    /* 回车直接播放 */
    if (this.dom.bgmInput) this.dom.bgmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onBgmPlay(); });
    if (this.dom.bgmInputLocal) this.dom.bgmInputLocal.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onBgmPlay(true); });
  }

  /* ---------- 本地文件模式（双击 index.html，无需服务器） ---------- */
  applyLocalMode() {
    this.mode = null;
    this.state = 'menu';
    this.dom.menu.classList.remove('waiting');
    this.dom.lobby.classList.add('hidden');
    /* 隐藏联机入口（本地文件没有服务器，无法中转消息） */
    const hostBtn = this.$('btn-host');
    const joinRow = document.querySelector('#menu .join-row');
    if (hostBtn) hostBtn.classList.add('hidden');
    if (joinRow) joinRow.classList.add('hidden');
    const hint = document.querySelector('#menu .hint.dim');
    if (hint) {
      hint.textContent = '本地模式：单人可直接开战 · 需要联机时用 node server.js 启动后访问 http://localhost:8080';
    }
  }

  /* ---------- BGM 背景音乐 ---------- */
  onBgmPlay(local) {
    const box = local ? this.dom.bgmInputLocal : this.dom.bgmInput;
    const url = (box ? box.value : '').trim();
    if (!url) { this.toast('请输入音频链接'); return; }
    this.setBgm(url);
    if (local) this.toast('本地BGM 开始播放');
  }

  onBgmStop() {
    this.stopBgm();
    /* 房主停止时通知所有客户端 */
    if (this.mode === 'net-host' && this.link) this.link.send({ t: 'bgm_stop' });
  }

  /* 选择本地音频文件：单人模式走 blob 直放；房主走服务端上传以便全房间同步 */
  onBgmFile(input, local) {
    const f = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!f) return;
    if (!/^audio\//.test(f.type || '') && !/\.(mp3|ogg|wav|m4a|aac|flac)$/i.test(f.name || '')) {
      this.toast('请选择音频文件（mp3/ogg/wav…）'); return;
    }
    if (f.size > BGM_MAX_FILE) { this.toast('音频文件不能超过 20MB'); return; }
    if (local || this.mode !== 'net-host') {
      this.releaseBgmObjectUrl();
      try { this.bgmObjectUrl = URL.createObjectURL(f); } catch (e) { this.toast('该文件无法读取'); return; }
      this.setBgm(this.bgmObjectUrl);
      this.toast('本地BGM 开始播放');
      return;
    }
    this.uploadBgm(f);
  }

  /* 房主：上传音频到服务端，按房间码临时存放，全房间共用同一个 URL */
  uploadBgm(file) {
    const room = this.room;
    if (!room) { this.toast('房间尚未建立'); return; }
    this.toast('正在上传BGM…');
    fetch('/api/bgm?room=' + encodeURIComponent(room), {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    }).then((r) => r.json()).then((j) => {
      if (!j || !j.ok) { this.toast((j && j.err) || '上传失败'); return; }
      this.setBgm(j.url);
      this.toast('房间BGM 已更新');
    }).catch(() => this.toast('上传失败，请检查网络'));
  }

  /* 服务端删除该房间的临时 BGM 文件（房间解散时） */
  clearServerBgm() {
    const room = this.room;
    if (!room || this.mode !== 'net-host') return;
    try { fetch('/api/bgm?room=' + encodeURIComponent(room), { method: 'DELETE' }).catch(() => {}); } catch (e) {}
  }

  releaseBgmObjectUrl() {
    if (!this.bgmObjectUrl) return;
    try { URL.revokeObjectURL(this.bgmObjectUrl); } catch (e) {}
    this.bgmObjectUrl = '';
  }

  setBgm(url) {
    this.bgmUrl = url;
    this.playBgm();
    /* 房主广播给所有客户端 */
    if (this.mode === 'net-host' && this.link) this.link.send({ t: 'bgm', url });
  }

  playBgm() {
    if (!this.bgmUrl) return;
    const url = this.bgmUrl;
    /* 避免重复设置相同 src */
    if (this.bgmAudio.src !== url) this.bgmAudio.src = url;
    this.bgmAudio.muted = this.bgmMuted;
    const p = this.bgmAudio.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        this.bgmPlaying = true;
        this.updateBgmUI();
      }).catch(() => {
        /* 自动播放被浏览器拦截 → 提示用户点击解锁 */
        this.toast('点击页面任意位置以播放BGM');
      });
    } else {
      this.bgmPlaying = true;
      this.updateBgmUI();
    }
  }

  stopBgm() {
    try {
      this.bgmAudio.pause();
      this.bgmAudio.currentTime = 0;
    } catch (e) {}
    this.bgmPlaying = false;
    this.updateBgmUI();
  }

  toggleBgmMute() {
    this.bgmMuted = !this.bgmMuted;
    this.bgmAudio.muted = this.bgmMuted;
    this.updateBgmUI();
    this.toast(this.bgmMuted ? '音乐已静音' : '音乐已开启');
  }

  updateBgmUI() {
    if (this.dom.bgmNow) {
      if (this.bgmPlaying && this.bgmUrl) {
        this.dom.bgmNow.classList.remove('hidden');
        this.dom.bgmNowText.textContent = '🎵 BGM 播放中';
      } else {
        this.dom.bgmNow.classList.add('hidden');
      }
    }
    if (this.dom.btnBgmMute) {
      if (this.bgmUrl) this.dom.btnBgmMute.classList.remove('hidden');
      else this.dom.btnBgmMute.classList.add('hidden');
      this.dom.btnBgmMute.classList.toggle('muted', this.bgmMuted);
      this.dom.btnBgmMute.textContent = this.bgmMuted ? '♪̸' : '♪';
    }
  }

  _onBgmError() {
    this.bgmPlaying = false;
    /* 区分「文件有问题」和「贴的其实是网页链接」 */
    const u = this.bgmUrl || '';
    if (u.startsWith('/api/bgm') || u.startsWith('blob:')) this.toast('BGM 文件无法解码，请换一个音频文件');
    else this.toast('这不是音频文件直链（需以 .mp3/.ogg/.wav 结尾）');
    this.updateBgmUI();
  }

  /* 可分享的对战链接：基于当前访问地址生成（公网域名 → 互联网链接；局域网 IP → 局域网链接）。
   * 保留反向代理所需参数（如 _port），叠加房间码 */
  shareUrl() {
    const p = new URLSearchParams(location.search);
    p.set('room', this.room);
    return location.origin + location.pathname + '?' + p.toString();
  }

  updateShareBox() {
    if (!this.dom.shareBox || !this.room) return;
    this.dom.shareUrl.value = this.shareUrl();
    this.dom.shareBox.classList.remove('hidden');
  }

  async copyShare() {
    const url = this.dom.shareUrl ? this.dom.shareUrl.value : '';
    let done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        done = true;
      }
    } catch (e) {}
    if (!done) {
      try { this.dom.shareUrl.select(); done = document.execCommand('copy'); } catch (e) {}
    }
    this.toast(done ? '链接已复制，发给好友即可加入' : '请手动选中复制链接');
  }

  toast(msg) {
    this.dom.toast.textContent = msg;
    this.dom.toast.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.dom.toast.classList.remove('show'), 2600);
  }

  /* ---------- 单人混战 ---------- */
  startBot() {
    this.mode = 'bot';
    const players = [{ id: this.myId, name: '你' }];
    for (let i = 0; i < BOT_COUNT; i++) players.push({ id: 'bot' + i, name: 'BOT-' + (i + 1) });
    /* 单人模式也进入技能选择 */
    this.skillSeed = (Math.random() * 1e9) | 0;
    this.startSkillPick(this.skillSeed, players);
    /* 为机器人随机分配技能 */
    const rng = mulberry32(this.skillSeed);
    for (let i = 0; i < players.length; i++) {
      if (players[i].id.startsWith('bot')) {
        const pool = SKILL_IDS.filter((id) => !Object.values(this.playerSkills).includes(id));
        this.playerSkills[players[i].id] = pool[Math.floor(rng() * pool.length)];
      }
    }
  }

  /* ---------- 网络对战 ----------
   * auto=true：访问网址时自动建房 → 成功后改写 URL 为带 room 形式，地址栏直接可分享 */
  async startHost(auto) {
    this.mode = 'net-host';   // 必须先设置：hostStart/broadcastLobby/netTick 均依赖
    this.room = genRoom();
    this.dom.menu.classList.add('waiting');
    this.dom.lobby.classList.remove('hidden');
    this.lobby = [{ id: this.myId, name: '房主(你)' }];
    this.renderLobby();
    this.dom.netStatus.innerHTML = '房间码 <b class="code">' + this.room + '</b><br>等待玩家加入…<br><span class="dim">传输通道连接中</span>';
    this.state = 'wait';
    this.link = await connectNet(this.room, this.myId);
    if (this.state !== 'wait') { this.link.close(); return; }
    this.lastMsg = performance.now();
    this.link.onMessage = (m) => this.onNetMsg(m);
    this.link.onClose = () => this.onNetLost();
    this.transName = this.link.kind === 'ws' ? '中继服务器' : '本机标签页';
    this.dom.netStatus.innerHTML = '房间码 <b class="code">' + this.room + '</b><br>等待玩家加入…<br><span class="dim">通道：' + this.transName + '</span>';
    this.updateShareBox();
    if (auto) {
      /* 自动建房：用 history.replaceState 改写地址栏为 ?room=XXXX，
       * 用户复制地址栏 URL 就能直接分享给朋友，朋友打开即自动加入 */
      try {
        const p = new URLSearchParams(location.search);
        p.set('room', this.room);
        const newUrl = location.pathname + '?' + p.toString() + location.hash;
        history.replaceState(null, '', newUrl);
      } catch (e) {}
    }
  }

  async startJoin() {
    const code = (this.dom.roomInput.value || '').trim().toUpperCase();
    if (code.length !== 4) { this.toast('请输入 4 位房间码'); return; }
    this.mode = 'net-client';
    this.room = code;
    this.dom.menu.classList.add('waiting');
    this.dom.lobby.classList.remove('hidden');
    this.dom.netStatus.innerHTML = '正在连接房间 <b class="code">' + code + '</b>…';
    this.state = 'wait';
    this.joinTimer = performance.now();
    this.link = await connectNet(this.room, this.myId);
    if (this.state !== 'wait') { this.link.close(); return; }
    this.lastMsg = performance.now();
    this.link.onMessage = (m) => this.onNetMsg(m);
    this.link.onClose = () => this.onNetLost();
    this.link.send({ t: 'hello' });
    this.transName = this.link.kind === 'ws' ? '中继服务器' : '本机标签页';
    this.dom.netStatus.innerHTML = '已连接，等待房主开始…<br><span class="dim">通道：' + this.transName + '</span>';
    this.updateShareBox();
  }

  /* 房主：广播大厅并（人数足够时）可开战 */
  broadcastLobby() {
    if (this.mode !== 'net-host') return;
    this.link.send({ t: 'lobby', players: this.lobby });
    this.renderLobby();
  }

  hostStart() {
    if (this.mode !== 'net-host' || this.state !== 'wait') return;
    if (this.lobby.length < 2) { this.toast('至少需要 2 名玩家才能开始'); return; }
    /* 先进入技能选择阶段：生成种子并广播 */
    this.skillSeed = (Math.random() * 1e9) | 0;
    this.link.send({ t: 'skill_phase', seed: this.skillSeed, players: this.lobby });
    this.startSkillPick(this.skillSeed, this.lobby);
  }

  /* ---------- 技能选择阶段 ---------- */
  startSkillPick(seed, players) {
    this.players = players;
    this.skillSeed = seed;
    this.skillState = 'pick';
    this.skillPicked = null;
    this.playerSkills = {};
    this.skillTimer = 15;  // 15秒选择时间
    /* 用种子生成3张技能卡 */
    const rng = mulberry32(seed);
    this.skillChoices = rollSkillCards(rng);
    this.dom.skillCards.innerHTML = '';
    this.dom.skillCards.style.pointerEvents = 'auto';
    this.dom.lobby.classList.add('hidden');
    this.dom.skillPick.classList.remove('hidden');
    this.dom.skillWaitHint.textContent = '';
    this.renderSkillCards();
  }

  renderSkillCards() {
    const container = this.dom.skillCards;
    container.innerHTML = '';
    for (let i = 0; i < this.skillChoices.length; i++) {
      const sid = this.skillChoices[i];
      const sk = getSkill(sid);
      if (!sk) continue;
      const card = document.createElement('div');
      card.className = 'skill-card' + (i === 2 ? ' random' : '');
      card.style.setProperty('--skill-color', sk.color);
      card.style.setProperty('--skill-glow', sk.color + '66');
      card.innerHTML =
        '<div class="skill-icon">' + sk.icon + '</div>' +
        '<div class="skill-name">' + sk.name + '</div>' +
        '<div class="skill-desc">' + sk.desc + '</div>' +
        '<div class="skill-tag">' + (i === 2 ? '随机卡' : '技能卡' + (i + 1)) + '</div>';
      card.addEventListener('click', () => this.pickSkill(sid, card));
      container.appendChild(card);
    }
  }

  pickSkill(sid, cardEl) {
    if (this.skillState !== 'pick') return;
    this.skillPicked = sid;
    /* 标记选中 */
    this.dom.skillCards.querySelectorAll('.skill-card').forEach((c) => c.classList.remove('selected'));
    cardEl.classList.add('selected');
    this.dom.skillCards.style.pointerEvents = 'none';
    this.dom.skillWaitHint.textContent = '已选择：' + getSkill(sid).name + '，等待其他玩家…';
    /* 发送选择给房主 */
    if (this.mode === 'net-client' || this.mode === 'net-host') {
      this.link.send({ t: 'skill_pick', skill: sid });
    }
    /* 房主自身直接记录 */
    if (this.mode === 'net-host') {
      this.playerSkills[this.myId] = sid;
      this.checkAllSkillsPicked();
    }
    /* 单人模式：记录后直接进入战斗 */
    if (this.mode === 'bot') {
      this.playerSkills[this.myId] = sid;
      this.finishSkillPick();
    }
  }

  /* 房主：检查所有玩家是否完成选择 */
  checkAllSkillsPicked() {
    if (this.skillState !== 'pick') return;
    const allPicked = this.lobby.every((p) => this.playerSkills[p.id]);
    if (allPicked || this.skillTimer <= 0) {
      /* 超时未选的玩家随机分配 */
      const rng = mulberry32(this.skillSeed);
      for (const p of this.lobby) {
        if (!this.playerSkills[p.id]) {
          const pool = SKILL_IDS.filter((id) => !Object.values(this.playerSkills).includes(id));
          const pick = pool.length ? pool[Math.floor(rng() * pool.length)] : choice(SKILL_IDS);
          this.playerSkills[p.id] = pick;
        }
      }
      /* 广播技能选择结果并开始战斗 */
      this.link.send({ t: 'skill_result', skills: this.playerSkills });
      this.finishSkillPick();
    }
  }

  finishSkillPick() {
    this.dom.skillPick.classList.add('hidden');
    this.skillState = null;
    /* 生成地图种子并开始 */
    const seed = (Math.random() * 1e9) | 0;
    if (this.mode === 'net-host') {
      this.link.send({ t: 'start', seed, players: this.lobby });
    }
    const players = this.lobby.length ? this.lobby : this.players;
    this.newRound(seed, players);
  }

  /* 更新技能选择计时器 */
  updateSkillTimer(dt) {
    if (this.skillState !== 'pick') return;
    this.skillTimer -= dt;
    if (this.dom.skillTimerFill) {
      const pct = Math.max(0, this.skillTimer / 15 * 100);
      this.dom.skillTimerFill.style.width = pct + '%';
    }
    if (this.mode === 'net-host' && this.skillTimer <= 0) {
      this.checkAllSkillsPicked();
    }
  }

  onNetMsg(m) {
    this.lastMsg = performance.now();
    const from = m.from;
    /* 房主：任意消息（含 ping）都刷新该玩家的在线时刻 */
    if (this.mode === 'net-host' && from) this.lastSeen.set(from, this.lastMsg);

    if (m.t === 'hello' || m.t === 'join') {
      /* 新玩家加入（host 维护名单；ws 的 join 与 hello 等价处理） */
      if (this.mode === 'net-host' && this.state === 'wait') {
        if (this.lobby.some((p) => p.id === from)) return;
        if (this.lobby.length >= MAX_PLAYERS) { this.link.send({ t: 'full', to: from }); return; }
        this.lobby.push({ id: from, name: 'P' + (this.lobby.length + 1) });
        this.broadcastLobby();
        /* 新玩家同步当前 BGM */
        if (this.bgmUrl && this.bgmPlaying) {
          this.link.send({ t: 'bgm', url: this.bgmUrl });
        }
        this.toast('玩家加入：' + from);
      } else if (this.mode === 'net-host' && this.state !== 'wait') {
        this.link.send({ t: 'full', to: from });
      }
    } else if (m.t === 'lobby') {
      if (this.state === 'wait' && !this.players.length) {
        this.lobby = m.players || [];
        this.joinTimer = 0;   // 已收到大厅，取消加入超时
        this.renderLobby();
      }
    } else if (m.t === 'start') {
      if (this.state !== 'wait' && this.skillState !== 'pick') return;
      this.mode = 'net-client';
      this.joinTimer = 0;
      this.lobby = m.players || [];
      this.newRound(m.seed, this.lobby);
    } else if (m.t === 'skill_phase') {
      /* 房主通知进入技能选择阶段 */
      if (this.state !== 'wait') return;
      this.mode = 'net-client';
      this.joinTimer = 0;
      this.lobby = m.players || [];
      this.startSkillPick(m.seed, this.lobby);
    } else if (m.t === 'skill_pick') {
      /* 客户端发送技能选择给房主 */
      if (this.mode === 'net-host' && this.skillState === 'pick') {
        this.playerSkills[from] = m.skill;
        this.checkAllSkillsPicked();
      }
    } else if (m.t === 'skill_result') {
      /* 房主广播技能结果 → 客户端记录并等待 start */
      if (this.skillState === 'pick') {
        this.playerSkills = m.skills || {};
        this.dom.skillPick.classList.add('hidden');
        this.skillState = null;
      }
    } else if (m.t === 'full') {
      if (m.to && m.to !== this.myId) return;
      this.toast(m.to ? '房间已满' : '房间已满或已开局');
      this.backToMenu();
    } else if (m.t === 'bye') {
      this.onPlayerLeft(from);
    } else if (m.t === 'inp') {
      if (this.mode !== 'net-host') return;
      let r = this.remoteInp.get(from);
      if (!r) { r = { l: false, r: false, b: false, j: false, a: false, ts: 0 }; this.remoteInp.set(from, r); }
      r.l = m.l; r.r = m.r; r.b = m.b;
      if (m.j) r.j = true;
      if (m.a) r.a = true;
      r.ts = performance.now();
    } else if (m.t === 'snap') {
      if (this.mode === 'net-client') this.applySnap(m);
    } else if (m.t === 'ev') {
      if (m.k === 'reset') {
        /* 不再直接开始，改为技能选择阶段 */
        this.lobby = m.players || this.lobby;
        this.playerSkills = {};
        this.startSkillPick(m.seed, this.lobby);
      }
    } else if (m.t === 'bgm') {
      /* 房主广播 BGM URL → 客户端播放 */
      this.bgmUrl = m.url || '';
      if (this.bgmUrl) this.playBgm();
      else this.stopBgm();
    } else if (m.t === 'bgm_stop') {
      /* 房主停止 BGM → 客户端也停止 */
      this.stopBgm();
    }
    /* ping 忽略（仅用于保活计时） */
  }

  onPlayerLeft(id) {
    if (this.mode === 'net-host') {
      this.lobby = this.lobby.filter((p) => p.id !== id);
      this.remoteInp.delete(id);
      this.lastSeen.delete(id);
      if (this.state === 'wait') {
        this.broadcastLobby();
        this.toast('玩家离开');
      } else {
        /* 战斗中离开：机甲标记死亡并检查结束 */
        const m = this.mechs.find((x) => x.id === id);
        if (m && !m.dead) { m.dead = true; m.hp = 0; m.state = 'ko'; }
        this.toast('玩家离开：' + id);
        this.checkEnd();
      }
    } else if (this.mode === 'net-client') {
      if (id && this.lobby.length && this.lobby[0].id === id) {
        this.toast('房主已离开');
        this.backToMenu();
      }
    }
  }

  onNetLost() {
    if (this.mode && this.mode.startsWith('net') && this.state !== 'menu') {
      this.toast('连接已断开');
      this.backToMenu();
    }
  }

  backToMenu() {
    /* 房主离开 = 房间解散：服务端删除该房间临时 BGM 文件 */
    this.clearServerBgm();
    if (this.link) { this.link.onClose = null; this.link.close(); this.link = null; }
    this.mode = null;
    this.state = 'menu';
    this.mechs = [];
    this.players = [];
    this.lobby = [];
    this.remoteInp.clear();
    this.lastSeen.clear();
    this.skillState = null;
    this.playerSkills = {};
    this.skillPicked = null;
    this._bombers = [];
    /* 房间解散：停止 BGM 并清空 */
    this.stopBgm();
    this.releaseBgmObjectUrl();
    this.bgmUrl = '';
    if (this.dom.bgmInput) this.dom.bgmInput.value = '';
    if (this.dom.bgmBar) this.dom.bgmBar.classList.add('hidden');
    this.dom.menu.classList.remove('hidden', 'waiting');
    this.dom.lobby.classList.add('hidden');
    this.dom.skillPick.classList.add('hidden');
    if (this.dom.shareBox) this.dom.shareBox.classList.add('hidden');
    this.dom.ko.classList.add('hidden');
    this.dom.roomTag.textContent = '';
    this.dom.netStatus.textContent = '';
    this.dom.others.innerHTML = '';
    this.world = new World(this, new GameMap((Math.random() * 1e9) | 0));
  }

  renderLobby() {
    if (!this.dom.lobbyList) return;
    const isHost = this.mode === 'net-host' || (!this.mode && this.state === 'wait');
    let html = '';
    for (let i = 0; i < this.lobby.length; i++) {
      const p = this.lobby[i];
      html += '<div class="lobby-player">' +
        '<span class="dot" style="background:' + PALETTES[i % PALETTES.length].body + '"></span>' +
        (p.id === this.myId ? '你' : (p.name || p.id)) +
        (i === 0 ? ' <span class="host-tag">房主</span>' : '') +
        '</div>';
    }
    for (let i = this.lobby.length; i < MAX_PLAYERS; i++) {
      html += '<div class="lobby-player empty">· 空位 ·</div>';
    }
    this.dom.lobbyList.innerHTML = html;
    this.dom.lobbyHint.textContent = '当前 ' + this.lobby.length + '/' + MAX_PLAYERS + ' 人';
    const hostReady = this.mode === 'net-host';
    this.dom.btnStart.classList.toggle('hidden', !hostReady);
    /* BGM 控制栏仅房主可见；客户端只显示当前 BGM 状态 */
    if (this.dom.bgmBar) this.dom.bgmBar.classList.toggle('hidden', !hostReady);
    this.updateBgmUI();
  }

  /* ---------- 回合 ---------- */
  newRound(seed, players) {
    this.players = players;
    this.map = new GameMap(seed);
    this.world = new World(this, this.map);
    this.fx = new FX();
    this.bots.clear();
    this.remoteInp.clear();
    this._bombers = [];

    /* 机甲按玩家顺序生成，出生点均分地图 */
    this.mechs = players.map((p, i) => {
      const m = new Mecha(this, p.id, i);
      m.name = p.id === this.myId ? '你' : (p.name || 'P' + (i + 1));
      const x = Math.round(((i + 1) / (players.length + 1)) * WORLD.w);
      m.reset(x, x < WORLD.w / 2 ? 1 : -1);
      if (p.id.startsWith('bot')) this.bots.set(p.id, new Bot());
      /* 分配技能 */
      const skillId = this.playerSkills[p.id];
      if (skillId) {
        m.skill = skillId;
        m.applySkill();
      }
      return m;
    });

    this.winner = null; this.koTimer = 0;
    this.state = 'fight';
    this.dom.menu.classList.add('hidden');
    this.dom.menu.classList.remove('waiting');
    this.dom.lobby.classList.add('hidden');
    this.dom.ko.classList.add('hidden');
    this.dom.roomTag.textContent = this.mode === 'bot' ? '混战 ' + players.length + ' 人' : ('房间 ' + this.room + ' · ' + players.length + ' 人');
    /* 相机立即定位 */
    const me = this.me();
    if (me) {
      this.cam.x = clamp(me.x - VIEW_W / 2, 0, WORLD.w - VIEW_W);
      this.cam.y = clamp(me.y - VIEW_H * 0.62, 0, WORLD.h - VIEW_H);
    }
    this.announce();
    this.dom.others.innerHTML = '';
  }

  announce() {
    const el = this.dom.announce;
    el.textContent = 'FIGHT!';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  checkEnd() {
    if (this.state !== 'fight') return;
    const alive = this.mechs.filter((m) => !m.dead);
    if (alive.length <= 1 && this.mechs.length > 1) {
      this.winner = alive.length === 1 ? alive[0] : null;
      this.state = 'ko';
      this.showEnd();
    }
  }

  mechName(m) {
    if (!m) return '';
    return m.id === this.myId ? '你' : m.name;
  }

  showEnd() {
    const iWin = this.winner && this.winner.id === this.myId;
    let text, sub;
    if (!this.winner) { text = '平局！'; sub = '全员同时被击败'; }
    else if (iWin) { text = '胜利！'; sub = '你是最后的幸存者'; }
    else { text = this.mechName(this.winner) + ' 获胜！'; sub = '你已被击败'; }
    this.dom.koText.textContent = text;
    this.dom.koText.style.color = iWin ? '#ffd23f' : '#ff6b6b';
    const canRestart = this.mode === 'bot' || this.mode === 'net-host';
    this.dom.btnRematch.classList.toggle('hidden', !canRestart);
    this.dom.koSub.textContent = canRestart ? '按 R 或点击按钮再来一局（新随机地图）' : '等待房主开始下一局…';
    this.dom.ko.classList.remove('hidden');
  }

  tryRematch() {
    if (this.mode === 'net-client') return;
    /* 重新进入技能选择 */
    this.playerSkills = {};
    this.skillSeed = (Math.random() * 1e9) | 0;
    if (this.mode === 'net-host') {
      this.link.send({ t: 'skill_phase', seed: this.skillSeed, players: this.lobby });
      this.startSkillPick(this.skillSeed, this.lobby);
    } else {
      /* bot 模式 */
      const players = this.players;
      const rng = mulberry32(this.skillSeed);
      this.startSkillPick(this.skillSeed, players);
      for (let i = 0; i < players.length; i++) {
        if (players[i].id.startsWith('bot')) {
          const pool = SKILL_IDS.filter((id) => !Object.values(this.playerSkills).includes(id));
          this.playerSkills[players[i].id] = pool[Math.floor(rng() * pool.length)];
        }
      }
    }
  }

  /* ---------- 网络同步 ---------- */
  /* 墙钟心跳（setInterval 驱动，后台仍运转）：
   * 1. 后台客户端补发输入（rAF 停摆时维持输入流）
   * 2. 双向保活 ping（约 1.4s 一个，后台节流下约 2s 一个）
   * 3. 掉线判定（总超时 + 房主逐玩家在线判定，均 10s）
   * 4. 加入超时 */
  netPump() {
    if (!this.link) return;
    const now = performance.now();

    /* 后台客户端：轮询输入并发送（KeyInput.pressed 会累积边沿直到被消费，不丢失） */
    if (this.mode === 'net-client' && document.hidden) {
      const li = this.localInput.poll();
      this._lastInp = li;
      if (li.jumpEdge) this.pending.j = true;
      if (li.attackEdge) this.pending.a = true;
      const p = this.pending;
      this.link.send({ t: 'inp', l: li.left, r: li.right, b: li.block, j: p.j ? 1 : 0, a: p.a ? 1 : 0 });
      p.j = false; p.a = false;
    }

    if (now - this._lastPing > 1400) {
      this._lastPing = now;
      this.link.send({ t: 'ping' });
    }

    if (this.state === 'menu') return;

    /* 总线超时：完全收不到任何消息 → 断线 */
    if (now - this.lastMsg > 10000) { this.onNetLost(); return; }

    /* 房主：逐玩家在线判定（任意消息含 ping 均刷新 lastSeen） */
    if (this.mode === 'net-host') {
      for (const [id, ts] of this.lastSeen) {
        if (now - ts > 10000) this.onPlayerLeft(id);
      }
    }

    /* 加入超时：连接后始终未收到房主大厅 */
    if (this.state === 'wait' && this.mode === null && this.joinTimer &&
        now - this.joinTimer > 7000) {
      this.toast('未找到房间（检查房间码，或让房主先创建）');
      this.backToMenu();
    }
  }

  snapMech(m) {
    const s = {
      i: m.idx,
      x: Math.round(m.x), y: Math.round(m.y), f: m.facing, s: m.state,
      h: m.hp, w: m.weapon.id, a: m.ammo,
      bs: Math.round(m.buffs.shield * 10), bb: Math.round(m.buffs.boost * 10),
      d: m.dead ? 1 : 0,
    };
    /* 宠物状态（驯兽大师） */
    if (m._pet) {
      s.px = Math.round(m._pet.x);
      s.py = Math.round(m._pet.y);
      s.ph = m._pet.hp;
      s.pm = m._pet.maxHp;
      s.pf = m._pet.facing;
      s.ps = m._pet.state || 'idle';
    }
    return s;
  }

  /* 应用单个机甲快照。isSelf：本端玩家（本地预测中，走软和解） */
  applyMechSnap(m, s, isSelf) {
    if (isSelf) {
      /* 自身：本地预测 + 和解。
       * 误差 <24px 视为"预测领先于快照"的正常时延偏移，不修正（避免持续回拖）；
       * 误差大（击退/被击飞/平台边缘分歧）则快速拉回权威位置 */
      const dx = s.x - m.x, dy = s.y - m.y;
      const err = Math.hypot(dx, dy);
      if (err > 24) {
        const k = err > 80 ? 0.65 : 0.35;
        m.x += dx * k; m.y += dy * k;
      }
      m._tx = null;   // 自身不走 smoothRemote 插值
      /* 状态：移动类（idle/walk/jump/block）由本地预测维护；
       * 攻击/受击/KO 为服务器权威 → 采用并重置动画计时 */
      if (s.s === 'attack' || s.s === 'hit' || s.s === 'ko') {
        if (m.state !== s.s) { m.state = s.s; m.stateTime = 0; }
        if (s.s === 'hit') m.hitstun = Math.max(m.hitstun, 0.06);
      }
      m.facing = s.f; m.hp = s.h;
      m.weapon = WEAPONS[s.w] || WEAPONS.blade; m.ammo = s.a;
      m.buffs.shield = s.bs / 10; m.buffs.boost = s.bb / 10;
      m.dead = !!s.d;
      /* 受击即时本地反应（击退方向按最近敌人估计，位移最终由和解收敛） */
      if (m._lastHp != null && s.h < m._lastHp && !m.dead) {
        m.hitstun = CFG.hitstun;
        m.state = 'hit'; m.stateTime = 0;
        let src = null, bd = 1e9;
        for (const e of this.mechs) {
          if (e === m || e.dead) continue;
          const d = Math.abs(e.x - m.x);
          if (d < bd) { bd = d; src = e; }
        }
        if (src) {
          const dir = src.x >= m.x ? -1 : 1;
          m.vx = dir * CFG.knockback; m.vy = -120; m.onGround = false;
        }
        this.fx.burst(m.x, m.y - 24, '#ffaaaa', 8, 120);
        this.shake = 4;
      }
    } else {
      m.x += (s.x - m.x) * 0.55;
      m.y += (s.y - m.y) * 0.55;
      m._tx = s.x; m._ty = s.y;   // 插值目标
      m.facing = s.f; m.state = s.s; m.hp = s.h;
      m.weapon = WEAPONS[s.w] || WEAPONS.blade; m.ammo = s.a;
      m.buffs.shield = s.bs / 10; m.buffs.boost = s.bb / 10;
      m.dead = !!s.d;
      if (m._lastHp != null && s.h < m._lastHp) {
        this.fx.burst(m.x, m.y - 24, '#ffaaaa', 8, 120);
        this.shake = 4;
      }
    }
    /* 宠物同步（驯兽大师）：客户端从快照恢复宠物位置/血量 */
    if (s.px != null) {
      if (!m._pet) {
        m._pet = {
          x: s.px, y: s.py, hp: s.ph, maxHp: s.pm || s.ph,
          facing: s.pf, state: s.ps || 'idle',
          cooldown: 0, stateTime: 0, animT: 0, vy: 0, onGround: true,
        };
      } else {
        m._pet.x += (s.px - m._pet.x) * 0.5;
        m._pet.y += (s.py - m._pet.y) * 0.5;
        m._pet.hp = s.ph;
        m._pet.maxHp = s.pm || m._pet.maxHp;
        m._pet.facing = s.pf;
        m._pet.state = s.ps || 'idle';
      }
    } else if (m._pet && this.mode === 'net-client') {
      m._pet = null;   /* 权威端宠物消失 → 客户端清除 */
    }
    m._lastHp = s.h;
  }

  applySnap(snap) {
    /* 增量创建/删除远端机甲 */
    const ids = new Set(Object.keys(snap.m));
    for (const [id, ms] of Object.entries(snap.m)) {
      let m = this.mechs.find((x) => x.id === id);
      if (!m) {
        m = new Mecha(this, id, ms.i);
        m.name = 'P' + (ms.i + 1);
        m.x = ms.x; m.y = ms.y;
        this.mechs.push(m);
      }
      this.applyMechSnap(m, ms, id === this.myId);
    }
    this.mechs = this.mechs.filter((m) => ids.has(m.id));
    const byId = {};
    for (const m of this.mechs) byId[m.id] = m;
    this.world.applySnap(snap.w, byId);
    /* 轰炸机同步：客户端从快照恢复轰炸机位置 */
    if (this.mode === 'net-client' && snap.b) {
      this._bombers = snap.b.map((b) => ({
        x: b.x, y: b.y, vx: b.vx, ownerId: b.o,
        dropT: 0.2, life: b.l, passes: b.p || 0,
      }));
    }
    if (snap.ko !== undefined && snap.ko !== null && this.state === 'fight') {
      this.winner = this.mechs.find((m) => m.id === snap.ko) || null;
      this.state = 'ko';
      this.showEnd();
    }
  }

  /* rAF 高频通道：仅负责战斗中的快照/输入发送（20~30Hz）。
   * 所有超时判定与保活已移至 netPump（墙钟驱动，后台不失效） */
  netTick(dt) {
    if (this.mode === 'net-host' && (this.state === 'fight' || this.state === 'ko')) {
      this.sendAcc += dt;
      if (this.sendAcc >= 0.05) {
        this.sendAcc = 0;
        const ms = {};
        for (const m of this.mechs) ms[m.id] = this.snapMech(m);
        this.link.send({
          t: 'snap',
          m: ms,
          w: this.world.serialize(),
          b: (this._bombers || []).map((b) => ({ x: Math.round(b.x), y: b.y, vx: Math.round(b.vx), o: b.ownerId, l: +b.life.toFixed(1), p: b.passes || 0 })),
          ko: this.state === 'ko' ? (this.winner ? this.winner.id : '') : null,
        });
      }
    } else if (this.mode === 'net-client') {
      this.sendAcc += dt;
      if (this.sendAcc >= 0.033) {
        this.sendAcc = 0;
        const p = this.pending, li = this._lastInp;
        this.link.send({
          t: 'inp',
          l: li ? li.left : false,
          r: li ? li.right : false,
          b: li ? li.block : false,
          j: p.j ? 1 : 0, a: p.a ? 1 : 0,
        });
        p.j = false; p.a = false;
      }
    }
  }

  /* 客户端帧间平滑：远端机甲向最近一次快照目标插值（自身由本地预测+和解负责） */
  smoothRemote(dt) {
    const k = Math.min(1, dt * 10);
    for (const m of this.mechs) {
      if (m.id === this.myId || m._tx == null) continue;
      m.x += (m._tx - m.x) * k;
      m.y += (m._ty - m.y) * k;
    }
  }

  /* ---------- 主循环 ---------- */
  loop(now) {
    const dt = Math.min(0.033, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.render();
    requestAnimationFrame((n) => this.loop(n));
  }

  update(dt) {
    /* 技能选择阶段倒计时 */
    if (this.skillState === 'pick') {
      this.updateSkillTimer(dt);
      return;  // 技能选择阶段不执行游戏逻辑
    }

    /* 快捷键 */
    if (this.localInput.k.consume('KeyR')) {
      if (this.state === 'ko' && (this.mode === 'bot' || this.mode === 'net-host')) this.tryRematch();
    }
    if (this.localInput.k.consume('Escape') && this.state !== 'menu') this.backToMenu();

    if (this.link) this.netTick(dt);
    if (!this.mode) return;   // 菜单状态：仅背景

    const myInp = this.localInput.poll();
    this._lastInp = myInp;

    if (this.mode === 'net-client') {
      /* 客户端：收集输入边沿 + 自身机甲本地预测（移动/跳跃即时响应，互联网延迟下不迟滞）。
       * 攻击不预测（服务器权威，避免状态/伤害闪烁）；远端机甲走快照插值 */
      if (myInp.jumpEdge) this.pending.j = true;
      if (myInp.attackEdge) this.pending.a = true;
      const me = this.me();
      if (me) {
        /* 死亡后也继续 update：KO 倒地动画需要物理下落 */
        me.update(dt, { ...myInp, attackEdge: false }, this.others());
      } else {
        this.smoothRemote(dt);
      }
      this.fx.update(dt);
      this.updateBombers(dt);
      return;
    }

    /* bot / net-host：权威模拟 */
    for (const m of this.mechs) {
      const enemies = this.mechs.filter((x) => x !== m);
      let inp;
      if (m.id === this.myId) inp = myInp;
      else if (this.mode === 'bot') {
        const bot = this.bots.get(m.id);
        inp = bot ? bot.think(dt, m, enemies, this.world)
                  : { left: false, right: false, block: false, jumpEdge: false, attackEdge: false };
      } else {
        /* 远端玩家输入 */
        const r = this.remoteInp.get(m.id);
        if (r) {
          inp = { left: r.l, right: r.r, block: r.b, jumpEdge: r.j, attackEdge: r.a };
          r.j = false; r.a = false;
        } else {
          inp = { left: false, right: false, block: false, jumpEdge: false, attackEdge: false };
        }
      }
      m.update(dt, inp, enemies);
    }
    this.world.update(dt, this.mechs, this.fx);
    this.updateBombers(dt);
    this.fx.update(dt);
    if (this.state === 'fight') this.checkEnd();

    /* KO 自动重开（仅机器人模式） */
    if (this.state === 'ko' && this.mode === 'bot') {
      this.koTimer += dt;
      if (this.koTimer > 5) this.tryRematch();
    }
  }

  updateCam(dt) {
    /* 自己死亡后观战：跟随最近存活者 */
    let target = this.me();
    if (!target || target.dead) {
      let bd = 1e9;
      for (const m of this.mechs) {
        if (m.dead) continue;
        const d = Math.abs(m.x - this.cam.x);
        if (d < bd) { bd = d; target = m; }
      }
    }
    if (!target) target = this.mechs[0];
    if (!target) return;
    const tx = clamp(target.x + target.facing * 24 - VIEW_W / 2, 0, WORLD.w - VIEW_W);
    const ty = clamp(target.y - VIEW_H * 0.62, 0, WORLD.h - VIEW_H);
    const k = Math.min(1, dt * 6);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
  }

  /* ---------- 渲染 ---------- */
  /* 轰炸机更新 */
  updateBombers(dt) {
    if (!this._bombers || !this._bombers.length) return;
    const fx = this.fx;
    /* 仅权威端（bot/net-host）投放炸弹，客户端炸弹由快照同步 */
    const isAuth = this.mode === 'bot' || this.mode === 'net-host';
    for (const b of this._bombers) {
      b.x += b.vx * dt;
      b.life -= dt;
      /* 到达地图边界：折返；完成一个来回后离场 */
      if (b.vx < 0 && b.x <= -20) {
        b.passes = (b.passes || 0) + 1;
        if (b.passes >= 2) { b.done = true; continue; }
        b.x = -20; b.vx = Math.abs(b.vx);
      } else if (b.vx > 0 && b.x >= WORLD.w + 20) {
        b.passes = (b.passes || 0) + 1;
        if (b.passes >= 2) { b.done = true; continue; }
        b.x = WORLD.w + 20; b.vx = -Math.abs(b.vx);
      }
      if (isAuth) {
        b.dropT -= dt;
        if (b.dropT <= 0) {
          b.dropT = 0.2;
          /* 丢炸弹：owner 为真实机甲，不误伤主人 */
          const owner = this.mechs.find((m) => m.id === b.ownerId);
          if (owner) {
            this.world.projs.push({
              x: b.x, y: b.y, vx: 0, vy: 80,
              dmg: 10, owner: owner,
              life: 5, bomb: true,
            });
          }
        }
      }
    }
    this._bombers = this._bombers.filter((b) => !b.done && b.life > 0);
  }

  /* 轰炸机绘制（机甲之后、特效之前） */
  drawBombers(ctx) {
    if (!this._bombers || !this._bombers.length) return;
    for (const b of this._bombers) {
      const f = b.vx > 0 ? 1 : -1;
      ctx.save();
      ctx.translate(Math.round(b.x), Math.round(b.y));
      ctx.scale(f, 1);
      /* 机身 */
      ctx.fillStyle = '#3a3a4e'; ctx.fillRect(-14, -4, 28, 8);
      ctx.fillStyle = '#4a4a6a'; ctx.fillRect(-12, -3, 24, 4);
      /* 机头 */
      ctx.fillStyle = '#2a2a3e'; ctx.fillRect(10, -2, 8, 4);
      ctx.fillStyle = '#ff9a3d'; ctx.fillRect(16, -1, 4, 2);
      /* 机翼 */
      ctx.fillStyle = '#2e2e44'; ctx.fillRect(-6, -10, 12, 6);
      ctx.fillStyle = '#1e1e34'; ctx.fillRect(-4, 4, 8, 6);
      /* 尾翼 */
      ctx.fillStyle = '#2e2e44'; ctx.fillRect(-14, -8, 4, 8);
      /* 驾驶舱玻璃 */
      ctx.fillStyle = '#4fd8ff'; ctx.fillRect(2, -3, 4, 3);
      ctx.fillStyle = '#9fe8ff'; ctx.fillRect(3, -3, 2, 2);
      ctx.restore();
      /* 投影阴影（地面） */
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#000';
      ctx.fillRect(Math.round(b.x - 12), WORLD.groundY, 24, 2);
      ctx.globalAlpha = 1;
    }
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.updateCam(1 / 60);

    this.shake = Math.max(0, this.shake - 0.4);
    const sx = this.shake > 0 ? rand(-1, 1) * this.shake : 0;
    const sy = this.shake > 0 ? rand(-1, 1) * this.shake : 0;

    this.world.drawBG(ctx, this.cam, this.time);

    ctx.save();
    ctx.translate(Math.round(-this.cam.x + sx), Math.round(-this.cam.y + sy));
    this.world.draw(ctx, this.time);
    /* 其他机甲先画，自己最后（前景） */
    for (const m of this.others()) m.draw(ctx);
    const me = this.me();
    if (me) me.draw(ctx);
    /* 轰炸机绘制 */
    this.drawBombers(ctx);
    this.fx.draw(ctx);
    ctx.restore();

    if (this.mode && this.mechs.length) {
      this.drawArrow(ctx);
      this.drawMinimap(ctx);
      this.updateHUD();
    }
  }

  drawArrow(ctx) {
    const me = this.me();
    if (!me) return;
    /* 指向最近存活敌人 */
    let e = null, bd = 1e9;
    for (const o of this.mechs) {
      if (o.dead || o.id === this.myId) continue;
      const d = Math.abs(o.x - me.x);
      if (d < bd) { bd = d; e = o; }
    }
    if (!e) return;
    const ex = e.x - this.cam.x;
    if (ex > 10 && ex < VIEW_W - 10) return;
    const y = clamp(e.y - this.cam.y - 30, 16, VIEW_H - 20);
    const left = ex <= 10, ax = left ? 10 : VIEW_W - 10;
    ctx.fillStyle = e.palette.body;
    ctx.beginPath();
    if (left) { ctx.moveTo(ax - 5, y); ctx.lineTo(ax + 5, y - 5); ctx.lineTo(ax + 5, y + 5); }
    else { ctx.moveTo(ax + 5, y); ctx.lineTo(ax - 5, y - 5); ctx.lineTo(ax - 5, y + 5); }
    ctx.closePath(); ctx.fill();
    const d = Math.round(Math.abs(e.x - me.x) / 10);
    ctx.font = '7px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = e.palette.light;
    ctx.fillText(d + 'm', ax, y + 13);
  }

  drawMinimap(ctx) {
    const w = Math.min(150, VIEW_W * 0.55), h = 5;
    const x = Math.round((VIEW_W - w) / 2), y = 6, s = w / WORLD.w;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = '#26263f';
    ctx.fillRect(x, y, w, h);
    for (const p of this.world.pads) { ctx.fillStyle = '#2f6f8f'; ctx.fillRect(x + p.x * s, y, 2, 2); }
    for (const d of this.world.drops) { ctx.fillStyle = '#ffd23f'; ctx.fillRect(x + d.x * s, y + 1, 1, 1); }
    for (const m of this.mechs) {
      if (m.dead) continue;
      ctx.fillStyle = m.palette.body;
      ctx.fillRect(Math.round(x + m.x * s) - 1, y, 3, 3);
    }
    const me = this.me();
    if (me) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(x + me.x * s) - 1, y - 1, 3, 5);
    }
  }

  /* 多人 HUD：右上其他玩家血条列表 */
  updateHUD() {
    const me = this.me();
    if (me) {
      this.dom.hpMe.style.width = Math.max(0, me.hp / CFG.maxHp * 100) + '%';
      this.dom.wepMe.textContent = me.weapon.name + (me.weapon.ammo ? ' ×' + me.ammo : '');
      const buffs = [];
      if (me.buffs.shield > 0) buffs.push('盾 ' + Math.ceil(me.buffs.shield) + 's');
      if (me.buffs.boost > 0) buffs.push('速 ' + Math.ceil(me.buffs.boost) + 's');
      this.dom.buffMe.textContent = buffs.join(' ');
    }

    /* 其他玩家：按 mechs 顺序维护 DOM */
    const others = this.others();
    const ids = new Set(others.map((m) => m.id));
    for (const el of Array.from(this.dom.others.children)) {
      if (!ids.has(el.dataset.id)) el.remove();
    }
    for (const m of others) {
      let el = this.dom.others.querySelector('[data-id="' + m.id + '"]');
      if (!el) {
        el = document.createElement('div');
        el.className = 'mini-fighter';
        el.dataset.id = m.id;
        el.innerHTML = '<div class="mf-row"><span class="mf-name"></span></div>' +
          '<div class="mf-bar"><div class="mf-fill"></div></div>';
        this.dom.others.appendChild(el);
      }
      const nameEl = el.querySelector('.mf-name');
      if (nameEl.textContent !== m.name) nameEl.textContent = m.name;
      nameEl.style.color = m.palette.light;
      const fill = el.querySelector('.mf-fill');
      fill.style.width = Math.max(0, m.hp / CFG.maxHp * 100) + '%';
      fill.style.background = m.palette.body;
      el.classList.toggle('ko', m.dead);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new App(); });

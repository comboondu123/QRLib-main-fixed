const { createApp } = Vue;

createApp({
    data() {
        return {
            presets: [],
            currentPreset: 'vip',
            qrImage: null,
            qrsig: null,
            loading: false,
            status: { ret: '', msg: '' },
            logs: [],
            pollTimer: null,
            cookie: null,
            nickname: '',
            toast: '',
            customAppId: '',
            avatar: '',
            credentials: { uin: '', code: '', ticket: '', skey: '', pSkey: '', cookie: '' },
            reason: '',
            steps: [],
            loginSuccess: false
        }
    },
    mounted() {
        this.fetchPresets();
        this.log('System initialized. Ready for user input.', 'system');
    },
    computed: {
        currentPresetMeta() {
            return this.presets.find(p => p.key === this.currentPreset) || null;
        },
        hasAnyCredential() {
            const c = this.credentials;
            return Boolean(c.uin || c.code || c.ticket || c.cookie);
        }
    },
    methods: {
        log(msg, type = 'info') {
            const time = new Date().toLocaleTimeString('en-US', { hour12: false });
            this.logs.unshift({ time, msg, type });
            if (this.logs.length > 200) this.logs.pop();
        },

        showToast(msg) {
            this.toast = msg;
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => { this.toast = ''; }, 1800);
        },

        async fetchPresets() {
            try {
                const res = await fetch('/api/presets');
                this.presets = await res.json();
                this.log(`Loaded ${this.presets.length} presets from server.`);
            } catch (e) {
                this.log('Failed to load presets: ' + e.message, 'error');
            }
        },

        selectPreset(key) {
            this.currentPreset = key;
            this.stopPolling();
            this.qrImage = null;
            this.qrsig = null;
            this.cookie = null;
            this.status = { ret: '', msg: '' };
            this.avatar = '';
            this.nickname = '';
            this.reason = '';
            this.steps = [];
            this.credentials = { uin: '', code: '', ticket: '', skey: '', pSkey: '', cookie: '' };
            this.loginSuccess = false;

            const preset = this.presets.find(p => p.key === key);
            this.customAppId = preset && preset.type === 'mp' ? (preset.defaultAppId || '') : '';
            this.log(`Switched preset to: ${this.getCurrentPresetName()}`);
        },

        async fetchQRCode() {
            if (this.loading) return;
            this.loading = true;
            this.stopPolling();
            this.status = { ret: '', msg: 'Generating QR...' };
            this.cookie = null;
            this.qrImage = null;
            this.nickname = '';
            this.avatar = '';
            this.reason = '';
            this.steps = [];
            this.credentials = { uin: '', code: '', ticket: '', skey: '', pSkey: '', cookie: '' };
            this.loginSuccess = false;

            try {
                this.log(`Requesting QR Code for ${this.currentPreset}...`);
                const res = await fetch('/api/qr/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ preset: this.currentPreset })
                });
                const data = await res.json();

                if (data.success) {
                    this.qrImage = data.qrcode;
                    this.qrsig = data.qrsig;
                    this.log('QR Code generated successfully.');
                    if (data.oauthMode === false) {
                        this.log('提示：该登录目标不提供 OAuth code，将返回 Cookie 凭证（uin / skey / p_skey）。');
                    }
                    this.status = { ret: '', msg: 'Scan with QQ Mobile' };
                    this.startPolling();
                } else {
                    this.log('QR Generation Failed: ' + data.message, 'error');
                    this.status = { ret: '', msg: 'Generation Failed' };
                }
            } catch (e) {
                this.log('Network Error: ' + e.message, 'error');
                this.status = { ret: '', msg: 'Network Error' };
            } finally {
                this.loading = false;
            }
        },

        startPolling() {
            this.log('Started polling for login status...');
            this.pollTimer = setInterval(this.checkStatus, 2000);
        },

        stopPolling() {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
        },

        async checkStatus() {
            if (!this.qrsig) return;

            try {
                const res = await fetch('/api/qr/check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        qrsig: this.qrsig,
                        preset: this.currentPreset,
                        appid: this.customAppId || undefined
                    })
                });
                const data = await res.json();

                if (!data.success) {
                    // 参数/服务端错误：停止轮询，避免无意义的请求风暴
                    this.stopPolling();
                    this.log(`Check failed: ${data.message}`, 'error');
                    this.status = { ret: '65', msg: data.message || 'Check Failed' };
                    return;
                }

                if (data.msg && data.msg !== this.status.msg) {
                    this.status.msg = data.msg;
                    this.log(`Status update: ${data.msg}`);
                }
                if (data.nickname) this.nickname = data.nickname;

                // 成功
                if (data.ret === '0') {
                    this.stopPolling();
                    this.loginSuccess = true;
                    this.qrImage = null;

                    this.avatar = data.avatar || '';
                    this.credentials = {
                        uin: data.uin || '',
                        code: data.code || '',
                        ticket: data.ticket || '',
                        skey: data.skey || '',
                        pSkey: data.p_skey || '',
                        cookie: data.cookie || ''
                    };
                    this.reason = data.code ? '' : (data.msg || '');

                    (data.steps || []).forEach(s => {
                        this.log(`↳ ${s.step}${s.host ? '@' + s.host : ''} ${s.ok ? 'OK' : 'FAIL'}${s.detail ? ' · ' + s.detail : ''}`,
                            s.ok ? 'info' : 'error');
                    });

                    if (data.code) {
                        this.log('登录成功，已获取 Authorization Code 🎉');
                    } else {
                        this.log('登录成功，但未取到 code：' + this.reason, 'error');
                    }
                }
                // 已失效 / 失败
                else if (data.ret !== '66' && data.ret !== '67') {
                    this.stopPolling();
                    this.log('QR Code expired or failed.', 'error');
                }
            } catch (e) {
                console.error(e);
            }
        },

        copy(text, label) {
            const content = text || '';
            if (!content) return;

            const done = () => this.showToast(`已复制 ${label || ''}`.trim());
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(content).then(done).catch(() => this.fallbackCopy(content, done));
            } else {
                this.fallbackCopy(content, done);
            }
        },

        fallbackCopy(content, done) {
            const ta = document.createElement('textarea');
            ta.value = content;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { this.log('复制失败', 'error'); }
            document.body.removeChild(ta);
        },

        // Helper Methods for UI
        getCurrentPresetName() {
            const p = this.presets.find(p => p.key === this.currentPreset);
            return p ? p.name : 'Unknown';
        },

        getCurrentPresetDesc() {
            const p = this.presets.find(p => p.key === this.currentPreset);
            return p ? p.description : '';
        },

        getIconForPreset(key) {
            const map = {
                'vip': 'ph-crown',
                'qzone': 'ph-star',
                'music': 'ph-music-note',
                'wegame': 'ph-game-controller',
                'val': 'ph-crosshair',
                'miniprogram': 'ph-code',
                'farm': 'ph-plant'
            };
            return 'ph ' + (map[key] || 'ph-app-window');
        }
    }
}).mount('#app');

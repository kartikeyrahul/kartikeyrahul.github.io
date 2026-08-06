/* =====================================================================
   Design+ by Kartikey — token broker (Cloudflare Worker)
   ---------------------------------------------------------------------
   Iska kaam SIRF ek hai: Google ka refresh token sambhalna aur app ko
   jab chahiye tab naya access token de dena. Isse Drive baar-baar
   sign-in nahi maangta.

   Ye worker tumhare notes, files ya Quick Share ka data KABHI nahi
   dekhta. Wo sab pehle ki tarah seedha browser <-> Google Drive jaata hai.

   Refresh token yahan store nahi hota. Wo encrypt karke app ko wapas
   de diya jaata hai, aur app usko apne device pe rakhta hai. Kholne ki
   chaabi (BROKER_KEY) sirf is worker ke paas hai. Matlab worker
   stateless hai — koi database, koi KV, kuch nahi.

   ---------------------------------------------------------------------
   Cloudflare > Workers > Settings > Variables and Secrets me ye 4 daalo:

     CLIENT_ID      Google OAuth client id
     CLIENT_SECRET  Google OAuth client secret   (Secret rakhna)
     BROKER_KEY     koi bhi lambi random string  (Secret rakhna)
     APP_URL        https://kartikeyrahul.github.io
     DEV_EMAIL      developer ka Google email   (Secret rakhna)
                    -- ye set karoge tabhi Publisher dikhega

   Publishing ke liye teen aur (GitHub Pages par notes rakhne ke liye):

     GH_TOKEN       GitHub fine-grained token, Contents: Read+Write (Secret)
     GH_REPO        kartikeyrahul/design-plus-library
     GH_BRANCH      main            (na do to 'main' maan liya jaayega)

   Dhyan do: ye app wala repo NAHI hai. Library ka apna alag repo hai.
   Teen fayde --
     1. token app ke repo ko chhoo hi nahi sakta
     2. alag 1 GB milta hai, app ki jagah nahi khaata
     3. git ka itihaas bhaari ho jaye to repo mita kar dobara bana
        sakte ho; app par koi asar nahi
   Pages usi domain par aata hai (bas /design-plus-library/ path par),
   isliye same-origin ka fayda bana rehta hai.

   Repo ke andar:

     catalog.bin      poori list -- folders, items, tombstones (band)
     n/<id>.bin       ek note ki reader copy (band)
     img/<hash>.bin   tasveerein (band)
     k/<id>.json      chaabi, BROKER_KEY se dobara band ki hui

   Repo PRIVATE rakhna hai. GitHub Pages private repo se free me nahi
   chalta, isliye Pages chalu karne ki zarurat hi nahi -- files worker
   khud parosta hai (/f/... raste se), GitHub API se padh kar.

   Dohri suraksha ho gayi:
     1. repo private -- bina token ke koi file dekh hi nahi sakta
     2. file khud band (encrypted) -- token leak bhi ho jaye to bhi
        andar sirf koodha milega

   Har file ka jawab Cloudflare ke edge par cache hota hai, isliye
   GitHub par baar-baar bojh nahi padta aur reader ko file paas se
   milti hai.

   Google Cloud Console > Credentials > tumhara OAuth client me
   "Authorized redirect URIs" me ye add karna hai:

     https://<tumhara-worker>.workers.dev/cb

   ---------------------------------------------------------------------
   Setup theek hua ya nahi, ye kholke dekh lo:

     https://<tumhara-worker>.workers.dev/check

   ===================================================================== */

const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/* env values me galti se space ya newline aa jaata hai copy-paste me,
   isliye har jagah trim karke hi use karte hain */
function cfg(env) {
	return {
		id: String(env.CLIENT_ID || '').trim(),
		secret: String(env.CLIENT_SECRET || '').trim(),
		key: String(env.BROKER_KEY || '').trim(),
		app: String(env.APP_URL || '').trim().replace(/\/+$/, ''),
		/* Publisher ki chaabi. Ye app ke code me KABHI nahi ja sakti --
		   wo page GitHub par public hai. Sirf yahan, env me. */
		dev: String(env.DEV_EMAIL || '').trim().toLowerCase(),
		/* GitHub Pages = publishing ki jagah */
		gh: String(env.GH_TOKEN || '').trim(),
		repo: String(env.GH_REPO || '').trim().replace(/^\/+|\/+$/g, ''),
		branch: String(env.GH_BRANCH || 'main').trim(),
	};
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const c = cfg(env);
		const cors = {
			'Access-Control-Allow-Origin': c.app || '*',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			Vary: 'Origin',
		};

		cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';

		/* Reader kisi bhi origin se aa sakta hai -- jo mil raha hai wo
		   band hai, isliye khula rakhna surakshit hai. */
		const open = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		};

		if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

		try {
			if (url.pathname === '/check') return check(url, c);
			if (url.pathname === '/start') return await start(url, c);
			if (url.pathname === '/cb') return await callback(url, req, c);
			if (url.pathname === '/token') return await token(req, c, cors);
			if (url.pathname === '/whoami') return await whoami(req, c, cors);

			/* publishing -- sirf developer */
			if (url.pathname === '/have') return await have(req, c, cors);
			if (url.pathname === '/pub') return await pub(req, c, cors);
			if (url.pathname === '/pubmany') return await pubMany(req, c, cors);
			if (url.pathname === '/unpub') return await unpub(req, c, cors);
			if (url.pathname === '/access') return await access(req, c, cors);
			if (url.pathname === '/usage') return await usage(req, c, cors);

			/* reader ke raste */
			if (url.pathname.startsWith('/f/')) return await file(url, req, c, open);
			if (url.pathname === '/library') return await library(req, c, open);
			if (url.pathname === '/key') return await noteKey(req, c, open);
		} catch (e) {
			return jsonOut({ error: 'broker error', detail: String(e && e.message || e) }, 500, cors);
		}

		return new Response('Design+ broker is running.', {
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		});
	},
};

/* ---------- setup check: 4 cheezein sahi lagi ya nahi ----------
   client_id waise bhi public hoti hai (app ke code me bhi hai),
   isliye poori dikhana safe hai. Secret aur key kabhi nahi dikhati,
   sirf "hai ya nahi" batata hai. */
function check(url, c) {
	const out = {
		CLIENT_ID: c.id
			? { set: true, value: c.id, endsCorrectly: /\.apps\.googleusercontent\.com$/.test(c.id) }
			: { set: false, problem: 'CLIENT_ID missing ya khaali hai' },
		CLIENT_SECRET: c.secret
			? { set: true, length: c.secret.length, looksRight: c.secret.indexOf('GOCSPX-') === 0 }
			: { set: false, problem: 'CLIENT_SECRET missing ya khaali hai' },
		BROKER_KEY: c.key
			? { set: true, length: c.key.length, longEnough: c.key.length >= 20 }
			: { set: false, problem: 'BROKER_KEY missing ya khaali hai' },
		APP_URL: c.app
			? { set: true, value: c.app }
			: { set: false, problem: 'APP_URL missing ya khaali hai' },
		DEV_EMAIL: c.dev
			? { set: true, note: 'Publisher unlocked for this email' }
			: { set: false, note: 'Optional -- without it the Publisher stays hidden for everyone' },
		GH_TOKEN: c.gh
			? { set: true, length: c.gh.length, looksRight: /^(github_pat_|ghp_)/.test(c.gh) }
			: { set: false, note: 'Publishing off. Drive aur baaki sab pehle jaisa chalta rahega.' },
		GH_REPO: c.repo
			? { set: true, value: c.repo, looksRight: /^[^\/]+\/[^\/]+$/.test(c.repo) }
			: { set: false, note: 'owner/repo is tarah likhna hai' },
		GH_BRANCH: { set: true, value: c.branch },
		addThisToGoogle: url.origin + '/cb',
	};

	const bad = [];
	if (!c.id) bad.push('CLIENT_ID');
	if (!c.secret) bad.push('CLIENT_SECRET');
	if (!c.key) bad.push('BROKER_KEY');
	if (!c.app) bad.push('APP_URL');
	out.verdict = bad.length
		? 'NOT READY — these are missing: ' + bad.join(', ')
		: 'All four variables are set.';

	return new Response(JSON.stringify(out, null, 2), {
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

/* ---------- step 1: Google ki permission screen pe bhejo ---------- */
async function start(url, c) {
	if (!c.id) {
		return new Response('CLIENT_ID set nahi hai. Cloudflare > Settings > Variables and Secrets check karo, phir Deploy dabao.', {
			status: 500,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		});
	}

	const state = b64u(crypto.getRandomValues(new Uint8Array(18)));
	const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
	g.searchParams.set('client_id', c.id);
	g.searchParams.set('redirect_uri', url.origin + '/cb');
	g.searchParams.set('response_type', 'code');
	g.searchParams.set('scope', SCOPE);
	g.searchParams.set('access_type', 'offline'); /* refresh token isi se milta hai */
	g.searchParams.set('prompt', 'consent');      /* pehli baar zaroori, warna refresh token nahi aata */
	g.searchParams.set('include_granted_scopes', 'true');
	g.searchParams.set('state', state);

	return new Response(null, {
		status: 302,
		headers: {
			Location: g.toString(),
			/* state cookie: koi aur tumhare naam pe flow poora na kar de */
			'Set-Cookie': 'dpst=' + state + '; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax',
		},
	});
}

/* ---------- step 2: Google wapas bheje, code ko token me badlo ---------- */
async function callback(url, req, c) {
	const clear = 'dpst=; Path=/; Max-Age=0; Secure; SameSite=Lax';
	const back = (v) =>
		new Response(null, { status: 302, headers: { Location: c.app + '/#dpk=' + v, 'Set-Cookie': clear } });

	const code = url.searchParams.get('code');
	if (url.searchParams.get('error') || !code) return back('err');

	const want = url.searchParams.get('state') || '';
	const got = (req.headers.get('Cookie') || '').match(/dpst=([^;]+)/);
	if (!got || got[1] !== want) return back('err');

	const r = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: c.id,
			client_secret: c.secret,
			redirect_uri: url.origin + '/cb',
			grant_type: 'authorization_code',
		}),
	});
	const j = await r.json();
	if (!j.refresh_token) return back('norefresh');

	/* encrypt karke app ko de do — worker khud kuch store nahi karta */
	return back(await seal(j.refresh_token, c.key));
}

/* ---------- step 3: app jab bhi maange, naya access token do ---------- */
async function token(req, c, cors) {
	if (req.method !== 'POST') return jsonOut({ error: 'POST only' }, 405, cors);

	let k = '';
	try {
		k = (await req.json()).k || '';
	} catch (e) {}
	if (!k) return jsonOut({ error: 'no key' }, 400, cors);

	let refresh;
	try {
		refresh = await unseal(k, c.key);
	} catch (e) {
		/* bad:1 -> app apni saved key phenk dega aur dobara setup maangega */
		return jsonOut({ error: 'bad key', bad: 1 }, 200, cors);
	}

	const r = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: c.id,
			client_secret: c.secret,
			refresh_token: refresh,
			grant_type: 'refresh_token',
		}),
	});
	const j = await r.json();

	if (!j.access_token) {
		/* invalid_grant = user ne access hata diya, ya token mar gaya */
		return jsonOut({ error: j.error || 'refresh failed', bad: j.error === 'invalid_grant' ? 1 : 0 }, 200, cors);
	}
	return jsonOut({ access_token: j.access_token, expires_in: j.expires_in || 3600 }, 200, cors);
}

/* ---------- ye kaun hai? Publisher ka darwaza ----------
   App apna access token bhejti hai. Hum Google se KHUD poochte hain ki
   ye token kiska hai. Client jo bhejta hai us par bharosa nahi karte --
   koi bhi {dev:true} bhej sakta hai, isliye faisla hamesha yahan hota hai.

   DEV_EMAIL set nahi hai to Publisher kisi ke liye nahi khulta. */
async function whoami(req, c, cors) {
	if (req.method !== 'POST') return jsonOut({ error: 'POST only' }, 405, cors);
	if (!c.dev) return jsonOut({ dev: false }, 200, cors);

	let t = '';
	try {
		t = (await req.json()).t || '';
	} catch (e) {}
	if (!t) return jsonOut({ dev: false }, 200, cors);

	const r = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + t } });

	/* purane token me 'email' wali permission nahi thi. App ko chup-chaap
	   bata do -- wo Drive dobara connect karne par apne aap theek ho jayega. */
	if (r.status === 401 || r.status === 403) return jsonOut({ dev: false, needScope: 1 }, 200, cors);
	if (!r.ok) return jsonOut({ dev: false }, 200, cors);

	const j = await r.json();
	const email = String(j.email || '').trim().toLowerCase();
	if (!email) return jsonOut({ dev: false, needScope: 1 }, 200, cors);
	if (j.email_verified === false) return jsonOut({ dev: false }, 200, cors);

	/* email sirf tabhi wapas bhejte hain jab wo developer ka apna ho.
	   Kisi aur ka email is worker se kabhi bahar nahi jaata, aur kahin
	   likha bhi nahi jaata. */
	const ok = email === c.dev;
	return jsonOut(ok ? { dev: true, email: email } : { dev: false }, 200, cors);
}

/* ---------- chhote helpers ---------- */
function jsonOut(o, status, cors) {
	return new Response(JSON.stringify(o), {
		status,
		headers: Object.assign({ 'content-type': 'application/json' }, cors),
	});
}

function b64u(bytes) {
	const b = new Uint8Array(bytes);
	let s = '';
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(str) {
	const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}

async function aesKey(secret) {
	const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
	return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(text, secret) {
	const key = await aesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
	const out = new Uint8Array(12 + ct.byteLength);
	out.set(iv, 0);
	out.set(new Uint8Array(ct), 12);
	return b64u(out);
}


/* =====================================================================
   PUBLISHING - GitHub Pages par notes rakhne ka intezaam
   ---------------------------------------------------------------------
   Sochne ka tareeka simple hai:

     LIKHNA  -> hamesha is worker se hokar. Token yahin rehta hai,
                app ke code me kabhi nahi (wo page public hai).
     PADHNA  -> seedha GitHub Pages se. Worker beech me aata hi nahi,
                isliye reader kitne bhi ho, kuch kharcha nahi.

   Ek publish = EK commit. Chahe ek note ho ya das tasveerein, sab kuch
   ek hi commit me jaata hai (Git Data API se). Isse repo ka itihaas
   saaf rehta hai aur Pages baar-baar build nahi karta.
   ===================================================================== */

const GH = 'https://api.github.com';
/* library ka apna repo hai, isliye files seedhi jad me rehti hain.
   Kabhi shared repo par jaana pade to yahan 'library/' kar dena --
   baaki poora code waisa ka waisa chal jayega. */
const LIB = '';

function ghHead(c) {
	return {
		Authorization: 'Bearer ' + c.gh,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		/* GitHub bina User-Agent ke request thukra deta hai */
		'User-Agent': 'design-plus-publisher',
		'Content-Type': 'application/json',
	};
}

async function ghApi(c, path, init) {
	const r = await fetch(GH + path, Object.assign({ headers: ghHead(c) }, init || {}));
	const txt = await r.text();
	let j = null;
	try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
	if (!r.ok) {
		const m = (j && j.message) || txt.slice(0, 200) || ('HTTP ' + r.status);
		const err = new Error('GitHub: ' + m);
		err.status = r.status;
		throw err;
	}
	return j;
}

/* ---------- ek commit me kai files ----------
   files: [{ path, b64 }]   (path library/ ke andar ka)
   dels:  [ path, ... ]
   Khaali kaam par kuch nahi karta -- wahi commit dobara nahi banata. */
async function ghCommit(c, files, dels, msg) {
	files = files || [];
	dels = dels || [];
	if (!files.length && !dels.length) return { skipped: 1 };

	const R = '/repos/' + c.repo;
	const ref = await ghApi(c, R + '/git/ref/heads/' + encodeURIComponent(c.branch));
	const head = ref.object.sha;
	const commit = await ghApi(c, R + '/git/commits/' + head);

	const tree = [];
	for (let i = 0; i < files.length; i++) {
		const blob = await ghApi(c, R + '/git/blobs', {
			method: 'POST',
			body: JSON.stringify({ content: files[i].b64, encoding: 'base64' }),
		});
		tree.push({ path: LIB + files[i].path, mode: '100644', type: 'blob', sha: blob.sha });
	}
	/* sha: null = ye file hata do */
	for (let i = 0; i < dels.length; i++)
		tree.push({ path: LIB + dels[i], mode: '100644', type: 'blob', sha: null });

	const nt = await ghApi(c, R + '/git/trees', {
		method: 'POST',
		body: JSON.stringify({ base_tree: commit.tree.sha, tree: tree }),
	});
	const nc = await ghApi(c, R + '/git/commits', {
		method: 'POST',
		body: JSON.stringify({ message: msg || 'library update', tree: nt.sha, parents: [head] }),
	});
	await ghApi(c, R + '/git/refs/heads/' + encodeURIComponent(c.branch), {
		method: 'PATCH',
		body: JSON.stringify({ sha: nc.sha, force: false }),
	});
	return { commit: nc.sha, files: files.length, deleted: dels.length };
}

/* ---------- repo se ek file padho (raw) ---------- */
async function ghRead(c, path) {
	try {
		const j = await ghApi(c, '/repos/' + c.repo + '/contents/' + LIB + path +
			'?ref=' + encodeURIComponent(c.branch));
		if (!j || !j.content) return null;
		return new TextDecoder().decode(unb64u(String(j.content).replace(/\s+/g, '')
			.replace(/\+/g, '-').replace(/\//g, '_')));
	} catch (e) {
		if (e.status === 404) return null;
		throw e;
	}
}

/* ---------- kya ye file pehle se chadhi hui hai? ---------- */
async function ghHas(c, path) {
	try {
		await ghApi(c, '/repos/' + c.repo + '/contents/' + LIB + path +
			'?ref=' + encodeURIComponent(c.branch));
		return true;
	} catch (e) {
		if (e.status === 404) return false;
		throw e;
	}
}

/* ---------- har likhne wale raste ka darwaza ----------
   Client par kabhi bharosa nahi. Token Google ko dikha kar poochte hain
   ki ye kiska hai, aur DEV_EMAIL se milne par hi aage jaane dete hain. */
async function devBody(req, c, cors) {
	if (req.method !== 'POST') return { stop: jsonOut({ error: 'POST only' }, 405, cors) };
	if (!c.dev) return { stop: jsonOut({ error: 'publishing is off' }, 403, cors) };
	if (!c.gh || !c.repo)
		return { stop: jsonOut({ error: 'not set up', detail: 'GH_TOKEN / GH_REPO missing on the worker' }, 503, cors) };

	let b = {};
	try { b = await req.json(); } catch (e) {}
	const t = b.t || '';
	if (!t) return { stop: jsonOut({ error: 'not signed in' }, 401, cors) };

	const r = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + t } });
	if (!r.ok) return { stop: jsonOut({ error: 'not signed in' }, 401, cors) };
	const j = await r.json();
	const email = String(j.email || '').trim().toLowerCase();
	if (!email || j.email_verified === false || email !== c.dev)
		return { stop: jsonOut({ error: 'not allowed' }, 403, cors) };

	return { body: b };
}

/* ---------- chhoti safai ---------- */
function safeId(x) { return /^[A-Za-z0-9_-]{1,64}$/.test(String(x || '')) ? String(x) : ''; }
function safeName(x) { return String(x || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80); }
function cleanPath(p) {
	return String(p || '').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').slice(0, 200);
}


/* =====================================================================
   PUBLISH / UNPUBLISH
   ---------------------------------------------------------------------
   Yaad rakhne wali ek hi baat: is worker ke paas, aur GitHub ke paas,
   kabhi bhi note ka saaf roop nahi aata.

   App phone me hi note ko AES-256 se band karke bhejti hai. Worker us
   band dabbe ko waise ka waisa GitHub par rakh deta hai. Chaabi alag
   aati hai, aur wo GitHub par kabhi nahi jaati -- use BROKER_KEY se
   dobara band karke k/<id>.json me rakhte hain. Us par taala kholne
   wali chaabi sirf is worker ke paas hai.

   Matlab koi repo khol kar baithe raat bhar -- usko sirf koodha milega.
   ===================================================================== */

/* catalog bhi band rakhte hain. Sirf naam aur subject padh kar hi
   bahut kuch pata chal jaata hai, isliye wo bhi khula nahi chhodte. */
const CATF = 'catalog.bin';
const EMPTY = { v: 1, folders: [], items: [], tombstones: [] };

async function readCat(c) {
	const raw = await ghRead(c, CATF);
	if (!raw) return JSON.parse(JSON.stringify(EMPTY));
	try {
		const j = JSON.parse(await unseal(raw.trim(), c.key));
		j.folders = j.folders || [];
		j.items = j.items || [];
		j.tombstones = j.tombstones || [];
		return j;
	} catch (e) {
		throw new Error('catalog unreadable -- kya BROKER_KEY badal gayi hai?');
	}
}

async function catFile(c, cat) {
	cat.upd = Date.now();
	const sealed = await seal(JSON.stringify(cat), c.key);
	return { path: CATF, b64: btoa(sealed) };
}

function b64ok(x) {
	return typeof x === 'string' && x.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(x);
}

/* ---------- POST /have ----------
   Dobara publish karte waqt saari tasveerein phir se bhejna bewakoofi
   hai. App pehle poochti hai "inme se kaunsi tumhare paas nahi hai?",
   aur sirf wahi bhejti hai. */
async function have(req, c, cors) {
	const g = await devBody(req, c, cors);
	if (g.stop) return g.stop;

	const list = (g.body.names || []).slice(0, 400);
	const missing = [];
	for (let i = 0; i < list.length; i++) {
		const nm = safeName(list[i]);
		if (!nm) continue;
		if (!(await ghHas(c, 'img/' + nm))) missing.push(nm);
	}
	return jsonOut({ missing: missing }, 200, cors);
}

/* ---------- POST /pub ----------
   Ek note, uski nayi tasveerein, uski chaabi aur naya catalog --
   sab EK commit me. Ya to poora chadhta hai, ya kuch nahi. */
/* ---------- ek note ka saara saamaan taiyaar ----------
   Ye khud kuch upload nahi karta. Sirf files/dels me apna hissa daalta hai
   aur catalog me entry chipka deta hai. Isi wajah se ek note ho ya chalees,
   commit ek hi banta hai.
   Galat saamaan aaya to { err } wapas -- bulane wala tay karega kya karna hai. */
/* email list saaf karo: chhote akshar, duplicate hatao, 100 tak.
   Ye list note ke saath chalti hai -- members list se alag cheez hai. */
function cleanEmails(a) {
	const seen = {}, out = [];
	(a || []).slice(0, 300).forEach((x) => {
		const e = String((x && x.email) || x || '').trim().toLowerCase();
		if (!e || e.indexOf('@') < 1 || e.length > 120 || seen[e]) return;
		seen[e] = 1;
		out.push(e);
	});
	return out.slice(0, 100);
}

async function pubPrep(b, c, cat, files, dels) {
	b = b || {};
	const id = safeId(b.id);
	if (!id) return { err: 'bad id' };
	if (!b64ok(b.html)) return { err: 'no note' };
	if (!b.key) return { err: 'no key' };

	const vis = ['public', 'link', 'members'].indexOf(b.vis) > -1 ? b.vis : 'members';
	files.push({ path: 'n/' + id + '.bin', b64: b.html.replace(/\s+/g, '') });

	/* nayi tasveerein */
	const imgs = b.imgs || [];
	if (imgs.length > 200) return { err: 'too many images' };
	const names = [];
	for (let i = 0; i < imgs.length; i++) {
		const nm = safeName(imgs[i] && imgs[i].name);
		if (!nm || !b64ok(imgs[i].b64)) return { err: 'bad image' };
		files.push({ path: 'img/' + nm, b64: imgs[i].b64.replace(/\s+/g, '') });
		names.push(nm);
	}
	/* purani tasveerein jo pehle se chadhi hain, unke naam bhi note ke
	   saath rakhne hain -- warna delete ke waqt pata nahi chalega ki
	   kaunsi tasveer kis note ki thi */
	const allImgs = (b.allImgs || []).map(safeName).filter(Boolean);

	/* chaabi: app se aayi, ab BROKER_KEY se band karke rakhte hain */
	const sealedKey = await seal(String(b.key), c.key);
	files.push({
		path: 'k/' + id + '.json',
		b64: btoa(JSON.stringify({ v: 1, k: sealedKey })),
	});

	/* catalog me entry */
	const old = cat.items.filter((x) => x.id === id)[0];
	const now = Date.now();
	const it = {
		id: id,
		title: String(b.title || 'Untitled').slice(0, 300),
		subject: String(b.subject || '').slice(0, 120),
		cls: String(b.cls || '').slice(0, 60),
		folder: cleanPath(b.folder),
		vis: vis,
		perm: {
			copy: b.perm && b.perm.copy ? 1 : 0,
			download: b.perm && b.perm.download ? 1 : 0,
			print: b.perm && b.perm.print ? 1 : 0,
			save: b.perm && b.perm.save ? 1 : 0,
			edit: b.perm && b.perm.edit ? 1 : 0,
		},
		/* edit tools naam-wise diye jate hain -- ye list sirf isi note ki hai */
		eds: cleanEmails(b.editors),
		showLocked: b.showLocked ? 1 : 0,
		size: Number(b.size) || 0,
		imgs: allImgs.length ? allImgs : names,
		ver: old ? (old.ver || 1) + 1 : 1,
		pub: old ? old.pub || now : now,
		upd: now,
	};
	/* ---- jhalak (thumbnail) ----
	   Iski chaabi note ki chaabi se ALAG hai. Wajah saaf hai: jhalak dikhane
	   ke liye asli note ki chaabi baantni pade, ye theek nahi. Naam me version
	   rehta hai, isliye republish ke baad purani jhalak edge par nahi atakti. */
	if (b.thumb) {
		if (!b64ok(b.thumb)) return { err: 'bad thumb' };
		if (!b.tkey) return { err: 'no thumb key' };
		it.tf = id + '.v' + it.ver + '.bin';
		it.tmime = String(b.tmime) === 'image/webp' ? 'image/webp' : 'image/jpeg';
		it.tk = await seal(String(b.tkey), c.key);
		files.push({ path: 't/' + it.tf, b64: b.thumb.replace(/\s+/g, '') });
	} else if (old && old.tf) {
		it.tf = old.tf;
		it.tmime = old.tmime || 'image/jpeg';
		it.tk = old.tk || '';
	}
	if (old && old.tf && old.tf !== it.tf) dels.push('t/' + old.tf);

	/* ---- edit wali asli file ----
	   Library me jo file jati hai usme se toolkit nikal diya jata hai.
	   Jinhe developer ne edit ki ijazat di hai unke liye asli file alag se,
	   BILKUL ALAG chaabi ke saath rakhi jati hai. Wo chaabi sirf unhi ko
	   milti hai. Ijazat wapas li to file hi hat jati hai. */
	if (b.ehtml) {
		if (!b64ok(b.ehtml)) return { err: 'bad edit copy' };
		if (!b.ekey) return { err: 'no edit key' };
		it.ef = id + '.v' + it.ver + '.bin';
		it.ek = await seal(String(b.ekey), c.key);
		files.push({ path: 'e/' + it.ef, b64: b.ehtml.replace(/\s+/g, '') });
	} else if (old && old.ef && it.perm.edit) {
		it.ef = old.ef;
		it.ek = old.ek || '';
	}
	if (old && old.ef && old.ef !== it.ef) dels.push('e/' + old.ef);

	cat.items = cat.items.filter((x) => x.id !== id).concat([it]);
	if (it.folder && cat.folders.indexOf(it.folder) < 0) {
		/* folder aur uske sare parent, taaki khaali beech ka folder na chhoote */
		let p = it.folder;
		while (p) {
			if (cat.folders.indexOf(p) < 0) cat.folders.push(p);
			p = p.indexOf('/') > -1 ? p.slice(0, p.lastIndexOf('/')) : '';
		}
		cat.folders.sort();
	}
	/* dobara publish hui to purana tombstone hata do */
	cat.tombstones = (cat.tombstones || []).filter((x) => x.id !== id);

	return { it: it, newImages: names.length };
}

/* ---------- POST /pub ----------
   Ek note, uski nayi tasveerein, uski chaabi aur naya catalog --
   sab EK commit me. Ya to poora chadhta hai, ya kuch nahi. */
async function pub(req, c, cors) {
	const g = await devBody(req, c, cors);
	if (g.stop) return g.stop;

	const cat = await readCat(c);
	const files = [];
	const dels = [];
	const r1 = await pubPrep(g.body, c, cat, files, dels);
	if (r1.err) return jsonOut({ error: r1.err }, 400, cors);

	files.push(await catFile(c, cat));
	const r = await ghCommit(c, files, dels, 'publish: ' + r1.it.title.slice(0, 60));
	return jsonOut(
		{ ok: 1, id: r1.it.id, ver: r1.it.ver, vis: r1.it.vis, newImages: r1.newImages, commit: r.commit },
		200,
		cors,
	);
}

/* ---------- POST /pubmany ----------
   Kai notes ek hi baar me. Poora batch EK commit banta hai: ya to saare
   notes live hote hain, ya koi nahi -- aadha-adhoora catalog kabhi nahi.
   Ek note me gadbad mili to wahin ruk jate hain, kuch upload nahi hota.
   Chalees ki hadd: usse zyada me GitHub par blob chadhana lamba ho jata hai. */
async function pubMany(req, c, cors) {
	const g = await devBody(req, c, cors);
	if (g.stop) return g.stop;

	const list = (g.body && g.body.items) || [];
	if (!list.length) return jsonOut({ error: 'nothing to publish' }, 400, cors);
	if (list.length > 40) return jsonOut({ error: 'too many notes in one go' }, 400, cors);

	const cat = await readCat(c);
	const files = [];
	const dels = [];
	const out = [];
	const seen = {};
	for (let i = 0; i < list.length; i++) {
		const who = safeId(list[i] && list[i].id) || '';
		if (who && seen[who]) continue;              /* ek hi note do baar aayi to ek hi baar lo */
		const r1 = await pubPrep(list[i], c, cat, files, dels);
		if (r1.err) return jsonOut({ error: r1.err, at: i, id: who }, 400, cors);
		seen[r1.it.id] = 1;
		out.push({ id: r1.it.id, ver: r1.it.ver, vis: r1.it.vis, title: r1.it.title });
	}

	files.push(await catFile(c, cat));
	const r = await ghCommit(c, files, dels, 'publish: ' + out.length + ' notes');
	return jsonOut({ ok: 1, count: out.length, items: out, commit: r.commit }, 200, cors);
}

/* ---------- POST /unpub ----------
   Sirf list se hatana kaafi nahi -- file bhi jaani chahiye, chaabi bhi.
   Aur tombstone isliye rakhte hain taaki jin logo ne library pehle
   dekhi thi, unke device se bhi ye note apne aap gayab ho jaye. */
async function unpub(req, c, cors) {
	const g = await devBody(req, c, cors);
	if (g.stop) return g.stop;

	const id = safeId(g.body.id);
	if (!id) return jsonOut({ error: 'bad id' }, 400, cors);

	const cat = await readCat(c);
	const it = cat.items.filter((x) => x.id === id)[0];
	if (!it) return jsonOut({ ok: 1, already: 1 }, 200, cors);

	const dels = ['n/' + id + '.bin', 'k/' + id + '.json'];
	if (it.tf) dels.push('t/' + it.tf);          /* jhalak bhi jaani chahiye */
	if (it.ef) dels.push('e/' + it.ef);          /* edit wali asli file bhi */

	/* tasveer tabhi hatao jab koi doosri note use na kar rahi ho */
	const rest = cat.items.filter((x) => x.id !== id);
	const used = {};
	rest.forEach((x) => (x.imgs || []).forEach((h) => (used[h] = 1)));
	(it.imgs || []).forEach((h) => {
		if (!used[h]) dels.push('img/' + h);
	});

	cat.items = rest;
	cat.tombstones = (cat.tombstones || [])
		.filter((x) => x.id !== id)
		.concat([{ id: id, at: Date.now(), wipe: g.body.wipe ? 1 : 0 }]);

	/* khaali ho chuke folder list se nikal do */
	const live = {};
	cat.items.forEach((x) => {
		let p = x.folder;
		while (p) { live[p] = 1; p = p.indexOf('/') > -1 ? p.slice(0, p.lastIndexOf('/')) : ''; }
	});
	cat.folders = cat.folders.filter((f) => live[f] || (g.body.keepFolders ? 1 : 0));

	const files = [await catFile(c, cat)];
	const r = await ghCommit(c, files, dels, 'remove: ' + String(it.title || id).slice(0, 60));
	return jsonOut({ ok: 1, id: id, removed: dels.length, commit: r.commit }, 200, cors);
}


/* =====================================================================
   READER KE RASTE
   ---------------------------------------------------------------------
   Sabse zaroori baat: file dena aur CHAABI dena do alag cheezein hain.

   File koi bhi maang sakta hai -- wo band hai, uska kuch nahi bigdega.
   Chaabi maangne par hi asli jaanch hoti hai: tum kaun ho, aur kya
   developer ne tumhe is note ki ijazat di hai.

   Isse ek aur fayda hua: files edge par cache ho sakti hain (kyunki
   sabke liye ek jaisi hain), aur phir bhi content surakshit rehta hai.
   ===================================================================== */

const ACCF = 'access.bin';

/* private repo se file ka kaccha roop */
async function ghRaw(c, path) {
	/* cacheEverything: edge par pehle se pada ho to GitHub tak jaana hi na pade.
	   File band (encrypted) hai aur naam hi uska hash/version hai, isliye
	   lambi cache bilkul surakshit hai. */
	const r = await fetch(GH + '/repos/' + c.repo + '/contents/' + LIB + path +
		'?ref=' + encodeURIComponent(c.branch),
		{
			headers: Object.assign(ghHead(c), { Accept: 'application/vnd.github.raw' }),
			cf: { cacheEverything: true, cacheTtl: 604800 },
		});
	if (r.status === 404) return null;
	if (!r.ok) throw new Error('GitHub: HTTP ' + r.status);
	return r;
}

/* ---------- GET /f/n/<id>.bin , GET /f/img/<hash>.bin ----------
   Band file. Bina chaabi ke iska koi matlab nahi. */
async function file(url, req, c, open) {
	if (!c.gh || !c.repo) return jsonOut({ error: 'not set up' }, 503, open);

	const rest = url.pathname.slice(3);
	const m = rest.match(/^(n|img|t|e)\/([A-Za-z0-9._-]{1,80})$/);
	if (!m) return new Response('Not found', { status: 404, headers: open });

	/* pehle Cloudflare ke apne cache me dekho */
	const cache = caches.default;
	const hit = await cache.match(req);
	if (hit) return hit;

	const r = await ghRaw(c, m[1] + '/' + m[2]);
	if (!r) return new Response('Not found', { status: 404, headers: open });

	const out = new Response(r.body, {
		headers: Object.assign(
			{
				'content-type': 'application/octet-stream',
				/* tasveer ka naam hi uska hash hai -- wo kabhi badalti nahi.
				   Note badalne par uska naam bhi version ke saath badalta hai. */
				'cache-control': 'public, max-age=31536000, immutable',
				'x-content-type-options': 'nosniff',
			},
			open
		),
	});
	if (req.method === 'GET') await cache.put(req, out.clone());
	return out;
}

/* ---------- access list: kaun kya padh sakta hai ----------
   Emails bhi band karke rakhte hain. Kisi ki email kahin khuli padi
   mile, ye theek nahi lagta. */
async function readAcc(c) {
	const raw = await ghRead(c, ACCF);
	if (!raw) return { v: 1, members: [] };
	try {
		const j = JSON.parse(await unseal(raw.trim(), c.key));
		j.members = j.members || [];
		return j;
	} catch (e) {
		return { v: 1, members: [] };
	}
}

function memberOf(acc, email) {
	const now = Date.now();
	const m = (acc.members || []).filter((x) => String(x.email || '').toLowerCase() === email)[0];
	if (!m) return null;
	if (m.expires && Number(m.expires) < now) return null;
	return m;
}

/* note kis list me hai, aur kya ye banda us list me hai */
function canRead(it, email, acc, isDev) {
	const vis = it.vis || 'members';
	if (isDev) return 1;
	if (vis === 'public' || vis === 'link') return 1;
	if (!email) return 0;
	const m = memberOf(acc, email);
	if (!m) return 0;
	const lists = m.lists && m.lists.length ? m.lists : ['default'];
	const need = it.list || 'default';
	return lists.indexOf('*') > -1 || lists.indexOf(need) > -1 ? 1 : 0;
}

/* Edit tools ka faisla do talon wala hai: note par ijazat khuli ho, AUR
   padhne wale ka naam usi note ki list me ho. Developer ko hamesha. */
function canEdit(it, email, isDev) {
	if (!(it.perm && it.perm.edit)) return 0;
	if (isDev) return 1;
	if (!email) return 0;
	return (it.eds || []).indexOf(String(email).trim().toLowerCase()) > -1 ? 1 : 0;
}

/* Purani notes me save/print the hi nahi -- unke liye purana matlab rahega */
function permOut(it, mayEdit) {
	const p = it.perm || {};
	return {
		copy: p.copy ? 1 : 0,
		download: p.download ? 1 : 0,
		print: p.print == null ? 1 : p.print ? 1 : 0,
		save: p.save == null ? 1 : p.save ? 1 : 0,
		edit: mayEdit ? 1 : 0,
	};
}

/* kaun poochh raha hai? Token ho to Google se poochte hain.
   Token na ho to mehmaan -- sirf khuli cheezein dikhengi. */
async function whoIs(t, c) {
	if (!t) return { email: '', dev: 0 };
	const r = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + t } });
	if (!r.ok) return { email: '', dev: 0 };
	const j = await r.json();
	if (j.email_verified === false) return { email: '', dev: 0 };
	const email = String(j.email || '').trim().toLowerCase();
	return { email: email, dev: email && email === c.dev ? 1 : 0 };
}

/* ---------- POST /library ----------
   Jo tumhare liye hai wahi milega. Jo nahi hai, uska naam tak nahi --
   jab tak developer ne khud "taala dikhao" na chuna ho. */
async function library(req, c, open) {
	if (req.method !== 'POST') return jsonOut({ error: 'POST only' }, 405, open);
	if (!c.gh || !c.repo) return jsonOut({ error: 'not set up' }, 503, open);

	let b = {};
	try { b = await req.json(); } catch (e) {}
	const me = await whoIs(b.t, c);

	const cat = await readCat(c);
	const acc = await readAcc(c);
	const out = [];

	for (let i = 0; i < cat.items.length; i++) {
		const it = cat.items[i];
		/* link wali notes list me nahi aati -- unka rasta sirf link hai */
		if ((it.vis || 'members') === 'link' && !me.dev) continue;

		const can = canRead(it, me.email, acc, me.dev);
		if (!can && !it.showLocked) continue;

		/* jhalak bhi ek content hai -- wo bhi sirf usi ko jise padhne ki
		   ijazat hai. Locked note par app taala dikhati hai, jhalak nahi. */
		let tf = '', tmime = '', tk = '';
		if (can && it.tf) {
			tf = it.tf;
			tmime = it.tmime || 'image/jpeg';
			try { tk = it.tk ? await unseal(it.tk, c.key) : ''; } catch (e) { tf = ''; tk = ''; }
			if (!tk) tf = '';
		}

		out.push({
			id: it.id, title: it.title, subject: it.subject, cls: it.cls,
			folder: it.folder, vis: it.vis, size: it.size, imgs: it.imgs || [],
			ver: it.ver, pub: it.pub, upd: it.upd,
			perm: can
				? permOut(it, canEdit(it, me.email, me.dev) && it.ef ? 1 : 0)
				: { copy: 0, download: 0, print: 0, save: 0, edit: 0 },
			locked: can ? 0 : 1,
			tf: tf, tmime: tmime, tk: tk,
		});
	}

	const live = {};
	out.forEach((x) => {
		let p = x.folder;
		while (p) { live[p] = 1; p = p.indexOf('/') > -1 ? p.slice(0, p.lastIndexOf('/')) : ''; }
	});

	return jsonOut({
		v: 1, upd: cat.upd || 0, you: me.email ? 1 : 0, dev: me.dev,
		folders: (cat.folders || []).filter((f) => live[f]),
		items: out,
		tombstones: cat.tombstones || [],
	}, 200, open);
}

/* ---------- POST /key ----------
   Asli darwaza yahi hai. Yahan "nahi" ka matlab hai note kabhi khulegi
   hi nahi -- chahe file kisi ke paas pehle se padi ho. */
async function noteKey(req, c, open) {
	if (req.method !== 'POST') return jsonOut({ error: 'POST only' }, 405, open);
	if (!c.gh || !c.repo) return jsonOut({ error: 'not set up' }, 503, open);

	let b = {};
	try { b = await req.json(); } catch (e) {}
	const id = safeId(b.id);
	if (!id) return jsonOut({ error: 'bad id' }, 400, open);

	const cat = await readCat(c);
	const it = cat.items.filter((x) => x.id === id)[0];
	if (!it) return jsonOut({ error: 'gone', gone: 1 }, 404, open);

	/* link wali note ki chaabi link me hoti hai, worker se nahi milti */
	if ((it.vis || 'members') === 'link')
		return jsonOut({ error: 'use the link', link: 1 }, 403, open);

	const me = await whoIs(b.t, c);
	const acc = await readAcc(c);
	if (!canRead(it, me.email, acc, me.dev)) {
		/* sign in kiya hi nahi -- app usse sign in karne ko kahegi */
		if (!me.email) return jsonOut({ error: 'sign in', needAuth: 1 }, 401, open);
		return jsonOut({ error: 'not on the list', notAllowed: 1 }, 403, open);
	}

	const raw = await ghRead(c, 'k/' + id + '.json');
	if (!raw) return jsonOut({ error: 'gone', gone: 1 }, 404, open);
	let k = '';
	try {
		k = await unseal(JSON.parse(raw).k, c.key);
	} catch (e) {
		return jsonOut({ error: 'key unreadable' }, 500, open);
	}

	/* asli file ki chaabi -- sirf jinka naam is note ki list me hai */
	const mayEdit = canEdit(it, me.email, me.dev);
	let ef = '', ek = '';
	if (mayEdit && it.ef) {
		ef = it.ef;
		try { ek = it.ek ? await unseal(it.ek, c.key) : ''; } catch (e) { ek = ''; }
		if (!ek) ef = '';
	}

	return jsonOut({
		ok: 1, k: k, ver: it.ver, title: it.title,
		perm: permOut(it, mayEdit && ef ? 1 : 0),
		imgs: it.imgs || [],
		ef: ef, ek: ek,
	}, 200, open);
}

/* ---------- POST /access : list sambhalo (sirf developer) ---------- */
async function access(req, c, cors) {
	const g = await devBody(req, c, cors);
	if (g.stop) return g.stop;
	const b = g.body;

	const acc = await readAcc(c);
	if (b.set) {
		const seen = {};
		acc.members = (b.set || [])
			.slice(0, 2000)
			.map((x) => ({
				email: String((x && x.email) || x || '').trim().toLowerCase(),
				lists: (x && x.lists) || ['default'],
				expires: (x && x.expires) || null,
				at: (x && x.at) || Date.now(),
			}))
			.filter((x) => {
				if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email)) return false;
				if (seen[x.email]) return false;
				seen[x.email] = 1;
				return true;
			});
		const sealed = await seal(JSON.stringify(acc), c.key);
		await ghCommit(c, [{ path: ACCF, b64: btoa(sealed) }], [], 'access list update');
	}
	return jsonOut({ ok: 1, members: acc.members }, 200, cors);
}

/* ---------- POST /usage : kitni jagah bhar gayi (sirf developer) ---------- */
async function usage(req, c, cors) {
	const g = await devBody(req, c, cors);
	if (g.stop) return g.stop;

	const cat = await readCat(c);
	let bytes = 0;
	const imgs = {};
	cat.items.forEach((x) => {
		bytes += Number(x.size) || 0;
		(x.imgs || []).forEach((h) => (imgs[h] = 1));
	});
	return jsonOut({
		ok: 1,
		notes: cat.items.length,
		folders: (cat.folders || []).length,
		images: Object.keys(imgs).length,
		bytes: bytes,
		limit: 1073741824,
		upd: cat.upd || 0,
	}, 200, cors);
}

async function unseal(blob, secret) {
	const raw = unb64u(blob);
	const key = await aesKey(secret);
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
	return new TextDecoder().decode(pt);
}

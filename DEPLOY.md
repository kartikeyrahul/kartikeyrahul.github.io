# Design+ v2.17.0 — sab kuch wapas chalane ki guide

Code bilkul theek hai. Maine dono script blocks ka syntax check kiya — **koi error nahi**.
App isliye nahi chal rahi kyunki **deploy galat hua**, code toota nahi hai.

---

## Sabse badi galti (99% yahi hai)

**GitHub zip ko khud nahi kholta.** Tumne repo me `design-plus-v2170.zip` upload kiya, to
GitHub Pages ko wahan `index.html` milta hi nahi — sirf ek zip file dikhti hai.
Isliye site 404 deti hai ya purana cache dikhata hai.

Files ko **unzip karke, repo ki root me** rakhna zaroori hai. Aisa dikhna chahiye:

```
<repo>/
  index.html          <-- root me, kisi folder ke andar NAHI
  sw.js
  manifest.json
  icon.svg
  icon-192.png
  icon-512.png
  privacy.html
  reset.html          <-- naya repair tool
  robots.txt
  .nojekyll           <-- zaroori
  google18ef399b6a8226b2.html
  .well-known/assetlinks.json
  broker-worker.js    (sirf reference, Cloudflare me paste hota hai)
  BROKER-SETUP.md
  DEPLOY.md
  README.md
```

Agar files `design-plus-v2170/index.html` ke andar chali gayin, to app
`kartikeyrahul.github.io/design-plus-v2170/` par khulegi — aur wo **naya origin path** hai,
jis par Google OAuth aur broker set nahi hai. Sab kuch tootega.

---

## Step 1 — Repo ka naam bilkul sahi karo

App ka address `https://kartikeyrahul.github.io` hai (koi path nahi, seedha root).
Wo address sirf tab milta hai jab repo ka naam **exactly** ye ho:

```
kartikeyrahul.github.io
```

Settings → General → Repository name → yahi likho → Rename.

> Kisi bhi doosre naam se URL `kartikeyrahul.github.io/<naam>/` ban jaayega,
> aur tab Google sign-in + broker dono fail honge.

---

## Step 2 — Purani files hatao, nayi daalo

1. Repo me jo `.zip` pada hai use **delete** karo.
2. Neeche wale `design-plus-v2170-CLEAN.zip` ko **apne computer par unzip karo**.
3. GitHub repo → **Add file → Upload files** → andar ki **saari files select karke** drag karo
   (folder nahi, files).
4. Commit karo.

**Dhyan do:** `.nojekyll` aur `.well-known` chhup jaate hain. Windows me
View → Hidden items ON karo, Mac me `Cmd + Shift + .` dabao. Ye dono zaroori hain —
`.nojekyll` na ho to Jekyll build kuch files kha jaata hai.

Agar `.well-known/assetlinks.json` upload nahi ho raha, to GitHub par
**Add file → Create new file** → naam me `.well-known/assetlinks.json` likho (slash apne aap folder bana dega)
→ content paste karo.

---

## Step 3 — GitHub Pages dobara chalu karo

Naya repo banane par Pages apne aap ON nahi hota.

Settings → **Pages** →
- Source: **Deploy from a branch**
- Branch: **main** , folder: **/ (root)**
- Save

2–3 minute ruko. **Actions** tab me green tick aana chahiye.
Phir kholo: `https://kartikeyrahul.github.io/index.html`

Agar 404 aaye → matlab `index.html` root me nahi hai, ya branch galat chuni hai.

---

## Step 4 — Purana service worker maaro (yahi "restore nahi ho raha" ki doosri wajah)

Tumhare phone/tab me purana service worker (`kn-v48`) abhi bhi zinda hai aur purani
tooti hui copy parosta rehta hai. Naya deploy hone ke baad bhi wahi dikhta hai.

Maine iske liye **`reset.html`** bana diya hai. Deploy ke baad kholo:

```
https://kartikeyrahul.github.io/reset.html
```

Wahan teen buttons hain:

| Button | Kya karta hai | Notes safe? |
|---|---|---|
| 🧹 Safai karo aur app kholo | service worker unregister + saara cache delete | **Haan, bilkul safe** |
| ➡ App kholo | seedha app, cache-bust ke saath | Haan |
| 💣 Sab kuch mitao | IndexedDB + localStorage + cache, sab | **Nahi — sab mit jaayega** |

Pehle **sirf pehla button** dabao. Upar diagnostics me dikhega ki tumhare device par
kitne notes abhi bhi bache hue hain.

Agar installed app (TWA / "Add to home screen") me abhi bhi purana dikhe:
Android Settings → Apps → Design+ → Storage → **Clear cache** (Clear data NAHI, warna notes jaayenge).

Maine `sw.js` ki cache id bhi `kn-v48` se **`kn-v49`** kar di hai, taaki naya deploy
hote hi purana shell apne aap chhoot jaaye.

---

## Step 5 — Cloudflare Worker check karo

Worker ka apna repo se koi lena-dena nahi, wo alag chal raha hai. Bas 5 variables verify karo:

Cloudflare → Workers → `design-plus-broker` → Settings → Variables and Secrets:

| Naam | Value | Type |
|---|---|---|
| `CLIENT_ID` | `272737864692-sku2o1ku4m42ff27j1bagucmok6kvn6s.apps.googleusercontent.com` | Text |
| `CLIENT_SECRET` | Google Cloud wala secret | Secret |
| `BROKER_KEY` | jo pehle set kiya tha — **badalna mat** | Secret |
| `APP_URL` | `https://kartikeyrahul.github.io` | Text |
| `DEV_EMAIL` | tumhara Google email | Secret |

> ⚠️ `BROKER_KEY` badal diya to purana refresh token khul hi nahi paayega aur
> dobara Connect Drive karna padega.

Publisher use karte ho to teen aur: `GH_TOKEN`, `GH_REPO` (`kartikeyrahul/design-plus-library`), `GH_BRANCH` (`main`).

Health check ke liye browser me kholo:
```
https://design-plus-broker.dailymovieshd.workers.dev/health
```
(app me hardcoded default yahi address hai: `DEFBRK`)

---

## Step 6 — Google Cloud OAuth check karo

console.cloud.google.com → APIs & Services → Credentials → tumhara OAuth client:

- **Authorized JavaScript origins** me hona chahiye: `https://kartikeyrahul.github.io`
- **Authorized redirect URIs** me hona chahiye: `https://design-plus-broker.dailymovieshd.workers.dev/cb`

`/cb` lagana mat bhoolna. Google ko lagne me 1–2 minute lagte hain.

---

## Tumhare notes gaye nahi hain

Ghabrane ki zarurat nahi — notes **IndexedDB `kn`** me hain, jo *origin* se bandhi hoti hai,
**repo se nahi**. Repo rename/delete karne se browser ka data nahi mitta.
Jab tak address `https://kartikeyrahul.github.io` hi rahe aur tumne "Clear site data" na dabaya ho,
sab wahin milega. `reset.html` upar hi count dikha dega.

Doosri copy Drive par bhi hai — Connect Drive karke sync chalate hi sab wapas aa jaayega.

---

## Chhota checklist

- [ ] Repo ka naam exactly `kartikeyrahul.github.io`
- [ ] Repo se `.zip` file delete
- [ ] `index.html` root me (folder ke andar nahi)
- [ ] `.nojekyll` upload hua
- [ ] `.well-known/assetlinks.json` upload hua
- [ ] Settings → Pages → main / root → Save
- [ ] Actions me green tick
- [ ] `https://kartikeyrahul.github.io/reset.html` → 🧹 Safai
- [ ] Cloudflare ke 5 variables sahi, `APP_URL` bina trailing slash
- [ ] Google OAuth origin + redirect URI sahi
- [ ] App khol kar Connect Drive → sync

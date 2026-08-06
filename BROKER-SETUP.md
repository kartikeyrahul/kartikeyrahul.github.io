> **v2.3.1 se ye setup kisi ko karne ki zarurat nahi.** App ka apna helper
> pehle se laga hua aata hai. Ye guide sirf tab kaam ki hai jab koi apna
> alag helper chalana chahe (jaise app fork karke).

# Auto-login setup (Drive baar-baar sign-in maange, uska ilaaj)

Ye optional hai. Na karo to app bilkul pehle jaisi chalti hai.

## Problem kya thi

Google browser wali app ko sirf **1 ghante ka access token** deta hai. Uske baad
naya lena padta hai. Naya lene ka "chup-chaap" tareeka Google ka ek chhupa iframe
hai, jise installed app (TWA) aur Chrome ki third-party cookie blocking rok deti
hai. Isliye app baar-baar sign-in maangti thi.

Iska poora ilaaj **refresh token** hai, jo Google sirf tab deta hai jab request me
**client secret** ho. Secret browser me nahi rakha ja sakta. Isliye ek chhota
helper chahiye jo secret sambhale.

`broker-worker.js` wahi helper hai.

## Ye helper kya karta hai aur kya nahi

- Karta hai: Google se refresh token lena, aur app ko naya access token dena.
- Nahi karta: tumhare notes, files, ya Quick Share ka data dekhna. Wo sab pehle
  ki tarah seedha browser se Google Drive jaata hai.
- Refresh token helper me **store nahi hota**. Wo encrypt karke app ko wapas
  diya jaata hai aur tumhare device pe rehta hai. Kholne ki chaabi sirf helper ke
  paas hai. Matlab koi database nahi, kuch bhi save nahi.

---

## Step 1 - Google Cloud Console

1. https://console.cloud.google.com/apis/credentials kholo
2. Apna OAuth client (Web application) kholo
3. **Client secret** copy kar lo (Step 2 me chahiye)
4. Abhi ke liye bas itna. Redirect URI Step 3 ke baad add karenge, kyunki tab
   tak worker ka address pata nahi hoga.

## Step 2 - Cloudflare Worker banao

1. https://dash.cloudflare.com pe account banao (free)
2. **Compute (Workers)** > **Create** > **Start with Hello World** > naam do,
   jaise `design-plus-broker` > **Deploy**
3. **Edit code** kholo, saara code hata do, `broker-worker.js` ka poora code
   paste karo, **Deploy** dabao
4. Worker ka address note kar lo, jaise
   `https://design-plus-broker.<tumhara-naam>.workers.dev`

## Step 3 - Worker ki settings me 4 cheezein daalo

Worker > **Settings** > **Variables and Secrets** > Add:

| Naam | Value | Type |
|---|---|---|
| `CLIENT_ID` | tumhara Google OAuth client id | Text |
| `CLIENT_SECRET` | Step 1 wala secret | **Secret** |
| `BROKER_KEY` | koi bhi lambi random string, khud banao | **Secret** |
| `APP_URL` | `https://kartikeyrahul.github.io` | Text |

`BROKER_KEY` kuch bhi lamba ho sakta hai, jaise 40+ characters. Ise kahin likh ke
rakh lo. Agar ise badal doge to app ko dobara Connect karna padega.

Save karke **Deploy** dabao.

## Step 4 - Redirect URI add karo

Wapas Google Cloud Console > Credentials > apna OAuth client >
**Authorized redirect URIs** > **Add URI**:

```
https://design-plus-broker.<tumhara-naam>.workers.dev/cb
```

`/cb` lagana mat bhoolna. **Save** dabao. Google ko lagne me 1-2 minute lag sakte hain.

## Step 5 - App me address daalo

1. App kholo > **Drive** > **Auto-login**
2. Worker ka address paste karo (bina `/cb` ke), jaise
   `https://design-plus-broker.abcd.workers.dev`
3. Save
4. **Connect Drive** dabao
5. Google permission screen ek baar aayegi - Allow karo

Bas. Uske baad Drive dobara sign-in nahi maangega.

---

## Check kaise karein ki chal raha hai

- Drive sheet me **Auto-login: ON** dikhna chahiye
- App band karke dobara kholo, ya kuch ghante baad kholo - status
  **Connected** rehna chahiye, sign-in screen nahi aani chahiye

## Kuch galat ho to

| Dikh raha hai | Wajah | Ilaaj |
|---|---|---|
| "Auto-login setup poora nahi hua" | redirect URI galat ya missing | Step 4 dobara check karo |
| "Google ne is baar lambi permission nahi di" | Google ne refresh token nahi bheja | Google account > Security > Third-party apps > Design+ > Remove access, phir dobara Connect |
| Auto-login: setup pending | address save hai par Connect nahi hua | Connect Drive dabao |
| Broker error 500 | koi variable missing hai | Step 3 ke chaaron check karo |

## Band karna ho to

App > Drive > Auto-login > address hata do > Save. App wapas pehle wale tareeke
par aa jaayegi.

Poori tarah access hatana ho to:
Google account > Security > Third-party apps > Design+ > Remove access.

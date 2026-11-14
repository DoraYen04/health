// Dashboard 登入：Firebase Authentication（Google 帳號）。
// Firebase 設定由 Firebase Hosting 的保留網址 /__/firebase/init.json 提供，不寫死在程式中。
// 本機開發（伺服器設定 DEV_AUTH_USER_ID）時不載入 Firebase，直接略過登入。

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

let auth = null;
let fb = null;

/** 初始化 Firebase；回傳 false 表示無法取得設定（例如不是透過 Firebase Hosting 開啟） */
export async function initAuth() {
  if (auth) return true;
  const res = await fetch('/__/firebase/init.json').catch(() => null);
  if (!res || !res.ok) return false;
  const cfg = await res.json();
  const [{ initializeApp }, authMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
  ]);
  fb = authMod;
  auth = fb.getAuth(initializeApp(cfg));
  await auth.authStateReady();
  return true;
}

export function currentUser() {
  return auth?.currentUser || null;
}

/** 取得 ID token（SDK 會在過期前自動更新）；未登入回傳空字串 */
export async function idToken() {
  const u = currentUser();
  return u ? u.getIdToken() : '';
}

export async function signIn() {
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await fb.signInWithPopup(auth, provider);
}

export async function signOut() {
  if (auth) await fb.signOut(auth);
}

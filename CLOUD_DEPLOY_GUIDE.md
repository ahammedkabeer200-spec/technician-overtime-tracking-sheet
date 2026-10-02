# ☁️ 24/7 Public Cloud Server Deployment & Security Guide

Your project in `C:\Users\AHAMM\Documents\Antigravity\Technician Overtime Tracking Sheet` is pre-configured with **Render Blueprint (`render.yaml`)** and **Docker (`Dockerfile`)** so it can run 24/7 on the public internet with automatic `HTTPS://` security without keeping your PC turned on.

---

## 🔐 1. How the Security & Login Works

1. **Publicly Accessible URL, Strictly Private Data:**
   - When someone opens your public link (on mobile or PC), they are immediately blocked by the **Authorized Supervisor & Engineer Login Screen**.
   - Every database API (`/api/records`, `/api/export-excel`, `/api/import-excel`, `/api/users`) is protected by **HMAC-SHA256 signed tokens** and **salted `scrypt` password hashing**.
2. **Default Accounts (Change Immediately After Signing In):**
   - **Main Supervisor (Full Admin):**
     - Username: `supervisor`
     - Password: `Supervisor@123`
   - **Duty Engineer:**
     - Username: `engineer1`
     - Password: `Engineer@123`
3. **Managing Engineers & Passwords:**
   - Sign in as `supervisor` → click the **🔐 Security & Logins** tab.
   - From there, you can **create new logins for your Supervisor or other Engineers**, **revoke/delete** any engineer's login, and **change your password**.
   - Every overtime entry automatically records **Logged by: [Supervisor/Engineer Name]** for full accountability.

---

## 🚀 2. Deploy to a Free 24/7 Public Server (Render.com or Railway.app)

### Option A: Render.com (Free Web Service + Automatic HTTPS)
1. Upload this folder (`C:\Users\AHAMM\Documents\Antigravity\Technician Overtime Tracking Sheet`) to a **private GitHub repository** (using [GitHub Desktop](https://desktop.github.com/) or `git push`).
2. Go to **[https://render.com](https://render.com)** and sign in with your GitHub account.
3. Click **New +** → **Blueprint** (or **Web Service**) and select your repository.
4. Render will automatically detect `render.yaml` and configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment Variables:** `NODE_VERSION=22.12.0` and an auto-generated cryptographic `AUTH_SECRET`.
5. Click **Deploy**. Within 2 minutes, Render will give you a permanent `https://technician-overtime-portal.onrender.com` link!
   - *(Tip: If you attach a Render Persistent Disk or deploy on Railway.app with a Volume mounted to `/data`, set environment variable `DATA_DIR=/data` so your SQLite database persists across server restarts, or use the **Export/Import Excel** button anytime to keep `.xlsx` backups!)*

### Option B: Railway.app (Instant Cloud Hosting with Persistent Volume)
1. Go to **[https://railway.app](https://railway.app)** → **New Project** → **Deploy from GitHub repo**.
2. Right-click your service in Railway → **Add Volume** → mount path `/data`.
3. In **Variables**, add `DATA_DIR=/data` and `AUTH_SECRET=your-secret-key`.
4. Under **Settings → Networking**, click **Generate Domain** to get your public `https://...up.railway.app` URL!

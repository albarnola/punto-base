# Punto Base — Phase 1: Setup

A one-time setup so your Mac is ready to build the Punto Base website with Claude Code. Plan for ~30 minutes. You'll only do this once.

---

## What you're installing and why

| Tool | What it does | Why we need it |
|------|--------------|----------------|
| **Node.js** | Runs JavaScript outside the browser | Claude Code is built on Node.js. Installing this gives us `npm`, the tool that installs Claude Code. |
| **Claude Code** | AI coding assistant in your terminal | This is the thing that writes the website with you. |
| **VS Code** | A free code editor (like Word, but for code) | Lets you see and open the project files visually. Optional but very helpful. |

We are **not** installing GitHub yet. We'll do that in Phase 4 when we deploy.

---

## Step 1 — Install Node.js

1. Open your web browser and go to **https://nodejs.org**
2. Click the big green button that says **"LTS"** (Long Term Support — the stable version).
3. A file ending in `.pkg` will download. Open it.
4. Click through the installer: Continue → Continue → Agree → Install. Enter your Mac password if asked.
5. When it says "The installation was successful," close the installer.

**How to confirm it worked:**

1. Open the **Terminal** app. (Press `Cmd + Space`, type "Terminal", hit Enter.)
2. Type this and press Enter:

   ```
   node --version
   ```
3. You should see something like `v20.11.0` or similar. Any version starting with `v18`, `v20`, or `v22` is fine.
4. Now type:

   ```
   npm --version
   ```
5. You should see something like `10.2.4`.

If both commands print numbers, Node.js is installed. ✅

---

## Step 2 — Install Claude Code

Still in Terminal, type this exactly and press Enter:

```
npm install -g @anthropic-ai/claude-code
```

It will scroll a bunch of text for 10–60 seconds. When you get your prompt back (the line with your username and `%` or `$`), it's done.

**How to confirm it worked:**

```
claude --version
```

You should see a version number printed.

---

## Step 3 — Log Claude Code into your Claude Pro account

In Terminal, type:

```
claude
```

The first time you run it, it will ask how you want to authenticate. Choose **"Claude account (Pro/Max)"** (or whatever the option for logging in with your existing subscription is called). It will open your browser, you log in like normal, and then it tells Claude Code you're authorized.

You only do this once.

When you see a prompt that says something like `>` waiting for you to type, type:

```
/exit
```

…to come back to the regular terminal. We'll properly start using Claude Code in Phase 2.

---

## Step 4 — Install VS Code (recommended but optional)

1. Go to **https://code.visualstudio.com**
2. Click "Download for Mac".
3. Open the downloaded `.zip` file. A "Visual Studio Code" app appears.
4. Drag it into your Applications folder.
5. Open it once from Applications so macOS confirms it's safe to run.

That's it for VS Code right now — we'll use it in Phase 3.

---

## Done with Phase 1? ✅

You should now have:

- [ ] Node.js installed (`node --version` works)
- [ ] Claude Code installed (`claude --version` works)
- [ ] Logged into Claude Code with your Claude Pro account
- [ ] VS Code installed in Applications

When all four boxes are checked, come back to our chat and tell me "ready for Phase 2" and we'll create your project folder and have your first conversation with Claude Code.

---

## If something goes wrong

The most common issues:

- **`command not found: npm` after installing Node.js** — Close Terminal completely and reopen it. Sometimes a fresh window is needed for it to pick up the new install.
- **`permission denied` when running `npm install -g`** — Try this version instead: `sudo npm install -g @anthropic-ai/claude-code` (it'll ask for your Mac password).
- **The Claude Code login page doesn't open** — Copy the URL it prints in the terminal and paste it into your browser manually.

Anything weirder than that — just paste the error message back to me here and I'll talk you through it.

# Punto Base — Phase 2: Your First Conversation with Claude Code

Goal of this phase: open Claude Code inside your project folder, learn its handful of commands, and have it scaffold the empty starting point of the website. ~15 minutes.

---

## Step 1 — Open Terminal in your project folder

The trick most beginners miss: Claude Code works on whatever folder you opened it in. So you need to open Terminal *inside* the "Personal Finance Website" folder, not in some random place.

**The easiest way (drag-and-drop):**

1. Open the **Terminal** app (`Cmd + Space`, type "Terminal", Enter).
2. In Terminal, type `cd ` (the letters c, d, then a space — don't press Enter yet).
3. Open **Finder** and find the **Personal Finance Website** folder.
4. **Drag the folder from Finder into the Terminal window.** Terminal will auto-fill the full path for you.
5. Now press Enter.

You're now "inside" the folder. To confirm, type:

```
pwd
```

It should print something ending in `Personal Finance Website`. ✅

> 💡 *Tip:* If you ever want to see what's in the folder, type `ls`. Right now it should show the two markdown guides I made you.

---

## Step 2 — Start Claude Code

Type:

```
claude
```

Press Enter.

The first time you run it inside this folder, it will ask something like:
**"Do you trust the files in this folder?"** → answer **Yes** (it's just your folder).

You'll then see a prompt where you can type. That's it — you're chatting with Claude Code.

---

## Step 3 — Useful commands to know

These all start with `/` and are typed at the Claude Code prompt:

| Command | What it does |
|---------|--------------|
| `/help` | Lists all commands |
| `/model` | Switch between Sonnet, Opus, Haiku |
| `/cost` | See how much usage this session has consumed |
| `/clear` | Wipe the conversation context (start fresh) — saves tokens for unrelated tasks |
| `/exit` | Quit Claude Code (also `Ctrl + D`) |

You'll mostly just type plain English. Treat it like texting a smart developer friend who's looking at your folder.

---

## Step 4 — Your first prompt (copy-paste this)

Once you see the Claude Code prompt waiting for input, paste this:

> I want to build a personal finance website called **Punto Base** (linked to my Spanish-language YouTube channel about personal finance). The first tool will be a budget calculator with these requirements:
>
> - Three top-level expense categories: **Gastos Fijos** (fixed), **Gastos Variables** (variable), **Gastos Recreacionales** (recreational).
> - Under each category, the user can add or remove their own subcategories (e.g., "Renta", "Comida", "Cine") with a monthly amount.
> - There's also an **Ingreso Mensual** (monthly income) input at the top.
> - At the bottom, show: total expenses per category, total monthly expenses, and **Ahorro Mensual** (income minus expenses) with a clear positive/negative indicator.
> - All data saved in the browser using `localStorage` so it persists between visits. No accounts, no backend.
> - Tech stack: plain HTML + CSS + JavaScript in a single `index.html` file (we can split later).
> - Language: all UI text in Spanish.
> - Visual style: clean, modern, mobile-friendly. Use a calm financial color palette (think soft greens for positive, soft reds for negative, neutral background).
>
> **Before you write any code**, please:
> 1. Summarize what you understand the project to be in your own words.
> 2. Propose a file structure for this MVP.
> 3. Ask me any clarifying questions you have.
>
> Don't create files yet.

That last instruction matters: it forces Claude Code to *plan first* instead of immediately writing 300 lines of code, which saves you tokens and lets you steer.

---

## Step 5 — Have a conversation

Claude Code will respond with its understanding, a proposed structure, and questions. Read carefully. Answer the questions in plain English. When you're happy with the plan, tell it:

> Looks good. Please create the files.

It will then create files in your folder. The first time it tries to write a file, it will **ask your permission** — say yes. (You can tell it "yes, and don't ask me again for file edits in this folder" if you trust it.)

Once it finishes, you should have at least an `index.html` in the folder. To see it work:

1. Open Finder, find `index.html` in your Personal Finance Website folder.
2. Double-click it. It opens in your browser. That's your website running locally.

---

## When you're done with Phase 2

You should have:

- [ ] Opened Terminal inside the Personal Finance Website folder
- [ ] Started Claude Code with `claude`
- [ ] Pasted the first prompt and had a conversation
- [ ] Approved file creation
- [ ] Opened `index.html` in your browser and seen *something* (even if rough)

It is **completely fine if the first version looks ugly or has bugs**. The point of Phase 2 is to get the loop going: type a request → Claude Code writes/edits files → refresh the browser → see it. We polish in Phase 3.

When you're ready, come back to this chat and tell me how it went. Paste anything weird, share what the page looks like, and we'll start improving.

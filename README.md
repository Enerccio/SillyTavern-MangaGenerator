# SillyTavern Manga & Image Prompt Generator

A powerful, modular storyboarding and prompt-engineering utility extension for SillyTavern. This extension bridges the gap between raw textual roleplay and visual asset pipeline management, allowing you to slice chat logs into sequential panel layouts and automatically compile high-fidelity image generation tags.

---

## 📖 Description

The **SillyTavern Manga Generator** (`enerccio/sillytavern-mangagenerator`) organizes complex chat logs into structured, episodic visual partitions. By analyzing the raw dialogue and descriptions of your active roleplay, it leverages advanced language models to create comprehensive panel scripts and corresponding image generation tags (Danbooru-style tokens paired with strict compositional parameters) for tools like Stable Diffusion, Forge, or Midjourney.

Built with scaling in mind, it features deep optimization for reasoning models, a clutter-free tabbed workspace, and responsive layout systems designed to preserve your flow.

---

## ✨ Key Features

* **🎭 Dual-Mode UI Framework:** Seamlessly toggle individual panel blocks between **Script Mode** (narrative storyboarding/panel text) and **Tags Mode** (AI image generation prompt outputs) within a clean, uniform, anti-pop layout grid.
* **🧠 Native Reasoning Token Support:** Explicitly captures and streams asynchronous reasoning steps (`<think>` blocks). Includes live debugging timers for *both* your storyboard scripts and tag outputs—fully prepared for deep reasoning models like DeepSeek-R1 and OpenAI's o-series.
* **🎯 Advanced Context Boundary Controls:** Avoid character amnesia or context bloat. Fine-tune sliding data frameworks (`splitCount`, `contextLeft`, `contextRight`) to give the AI precise local context along with surrounding narrative memory.
* **🪐 Smart UI State & Scroll Preservation:** Layout refreshes won't hijack your view. The extension safely caches and restores scroll positions across all internal views, maintaining layout stability if you scroll up to inspect items while text is streaming.
* **🧩 Layered Template Overrides & Addendums:** Total prompt control. Modify templates globally across a whole project or create granular prompt overrides. Standard rules can be dynamically appended on a standalone panel scale using the **Addendum** editor without wiping out global structures.
* **📋 Context-Aware Copy & Copy-All Mechanism:** Individual header copy buttons automatically detect your active view. The workspace features a global **Copy All** action that compiles all panels followed by all image tags into a single clean copy block.
* **🗂️ Interactive Workspace Organizer:** Easily create multiple projects, quickly rename active manga workspaces with instant keyboard commits (**Enter** / Blur), and organize them fluently using native **Drag-and-Drop** tab sorting.
* **⚙️ Comprehensive Global Defaults:** Set global default profiles in SillyTavern's extension settings (including Token budget, trigger rules, window configurations, and master prompts) to instantly pre-configure all newly created manga scripts.

---

## 🚀 Installation Guide

You can install this extension directly through SillyTavern's native module loader using the standard installation interface:

1. Launch your **SillyTavern** instance.
2. Open the **Extensions Menu** by clicking the **Extensions** icon (represented by a puzzle piece 🧩) in the top navigation menu bar.
3. Click on the **Extension Manager** button to open the installation panel.
4. Locate the **Install Extension** section at the top of the interface.
5. Paste the following URL directly into the input field verbatim: `https://github.com/enerccio/sillytavern-mangagenerator`
6. Click the **Install Extension** button right next to the input box.
7. Once the cloning process finishes successfully, **Refresh/Reload** your browser page to initialize the utility interface.

---

## 🛠️ Getting Started

1. Set your preferred templates and limits in the SillyTavern **Extension Settings** (puzzle piece sidebar configuration).
2. Open the **Manga Generator** panel from your extensions' sidebar.
3. Create a new manga project tab and assign your token budgets and sliding window sizes.
4. Click **Add Panel**; the extension automatically reads your chat positions and appends a layout partition segment.
5. Hit **Run Generation** to watch the AI build out the visual script layout, stage directors, and core text breakdowns.
6. Toggle the button layout over to **Tags** and select **Generate Tags** to instantly transform that freshly minted script data into an optimized prompt payload ready for your image generation pipelines!

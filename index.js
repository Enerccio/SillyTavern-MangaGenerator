import {
    compilePromptTemplate,
    error,
    getChatMetadata,
    getSettings,
    initializeRequestMetadata,
    loadSettings,
    log,
    setChatMetadata,
} from "./utils.js";
import {getCharacterCardFields, getMaxPromptTokens} from "/script.js";
import {getWorldInfoPrompt} from "/scripts/world-info.js";
import {t} from "/scripts/i18n.js";
import {renderExtensionTemplateAsync} from "/scripts/extensions.js";
import {EXTENSION_PATH} from "./conf.js";

const MANGA_DENOMINATOR = 'SOURCE MANUSCRIPT';
const MANGA_DENOMINATOR_START = `===== ${MANGA_DENOMINATOR} START =====`;
const MANGA_DENOMINATOR_END = `===== ${MANGA_DENOMINATOR} END =====`;
const LORE_DENOMINATOR = 'BACKGROUND LORE';
const LORE_DENOMINATOR_START = `===== ${LORE_DENOMINATOR} START =====`;
const LORE_DENOMINATOR_END = `===== ${LORE_DENOMINATOR} END =====`;

const DEFAULT_PROMPT = `OTHER: You are an expert Manga Scriptwriter and Storyboard Director. Your task is to adapt the ${MANGA_DENOMINATOR} raw roleplay text into a professional, highly visual manga script formatted by pages and panels. Keep the continuation of page numbers (if any).

### Content guidelines
1. Do not ignore any story elements
2. You have {{tokenBudget}} token budget, use it
3. Do not create panels for story content you already created before
4. Use provided ${LORE_DENOMINATOR} section as a source of background lore.

### Adaptation Guidelines
1. Visual Storytelling: Translate internal thoughts or narrative descriptions into visual actions, framing choices, or symbolic background elements.
2. Pacing: Break down the action logically. Dynamic, high-action scenes should have more panels per page with tighter focus. Emotional moments should have larger, isolated panels.
3. Character Consistency: Clearly describe expressions, poses, and camera angles to maintain character continuity.
4. Panel Layout: Specify the shape and impact of the panel (e.g., wide, vertical, borderless, splash page) to guide the visual flow.

{{additionalRules}}

### Output Formatting
For every page and panel, strictly use this structure:

# PAGE [Number] [ Very short punchy title e.g. The Arrival; The Mask Breaks; Ultimate Betrayal ]
## PANEL [Number]
- **Layout & Camera**: [e.g., Wide establishing shot, extreme close-up, Dutch angle, birds-eye view]
- **Visual Description**: [Detailed description of the characters, their exact poses, facial expressions, and the background environment or special effects like speed lines]
- **Dialogue**:
  - [Character Name]: "[Speech text]"
- **SFX / Thoughts**:
  - [Character Name] (Thought): "[Internal monologue]"
  - [SFX]: [Onomatopoeia description, e.g., *WHOOSH*, *THUD*, *RUMBLE*]
`;

class MangaSection {

    constructor() {
        this.reasoningText = null;
        this.reasoningTime = null;
        this.reasoningFinished = null;
        this.generatedText = null;
        this.promptOverride = null;
        this.contextStartMessage = null;
        this.startingMessage = null;
        this.contextEndMessage = null;
        this.endingMessage = null;
        this.additionalRules = null;
        this._generating = false;
        this._abort = null;
    }

    static fromJson(json) {
        const section = new MangaSection();
        section.reasoningText = json.reasoningText;
        section.reasoningTime = json.reasoningTime;
        section.reasoningFinished = json.reasoningFinished;
        section.generatedText = json.generatedText;
        section.promptOverride = json.promptOverride;
        section.startingMessage = json.startingMessage;
        section.endingMessage = json.endingMessage;
        section.additionalRules = json.additionalRules;
        section.contextStartMessage = json.contextStartMessage;
        section.contextEndMessage = json.contextEndMessage;
        return section;
    }

    toJson() {
        return {
            reasoningText: this.reasoningText,
            reasoningTime: this.reasoningTime,
            reasoningFinished: this.reasoningFinished,
            generatedText: this.generatedText,
            promptOverride: this.promptOverride,
            startingMessage: this.startingMessage,
            endingMessage: this.endingMessage,
            additionalRules: this.additionalRules,
            contextStartMessage: this.contextStartMessage,
            contextEndMessage: this.contextEndMessage
        };
    }

    isGenerating() {
        return this._generating;
    }

    setGenerating(generating) {
        this._generating = generating;
    }

    abortGenerating() {
        this._abort.abort();
    }

    setReasoning(reasoning, reasoningTime, reasoningFinished) {
        this.reasoningText = reasoning;
        if (!reasoningFinished)
            this.reasoningTime = reasoningTime;
        this.reasoningFinished = reasoningFinished;
    }

}

class Manga {

    constructor() {
        this.title = "Untitled"
        this.sections = [];
        this.promptOverride = null;
        this.tokenBudget = 4096;
        this.trigger = 'MangaGenerator'
        this.splitCount = 25;
        this.contextLeft = 25;
        this.contextRight = 25;
    }

    toJson() {
        return {
            title: this.title,
            sections: this.sections.map(section => section.toJson()),
            promptOverride: this.promptOverride,
            tokenBudget: this.tokenBudget,
            trigger: this.trigger,
            splitCount: this.splitCount,
            contextLeft: this.contextLeft,
            contextRight: this.contextRight,
        };
    }

    static fromJson(json) {
        const manga = new Manga();
        manga.title = json.title;
        manga.sections = json.sections.map(sectionJson => MangaSection.fromJson(sectionJson));
        manga.promptOverride = json.promptOverride;
        manga.tokenBudget = json.tokenBudget;
        manga.trigger = json.trigger;
        manga.splitCount = json.splitCount;
        manga.contextLeft = json.contextLeft;
        manga.contextRight = json.contextRight;
        return manga;
    }

}

class MangaContainer {

    constructor() {
        this.mangas = [];
        this.activeManga = -1;
    }

    toJson() {
        return {
            mangas: this.mangas.map(manga => manga.toJson()),
            activeManga: this.activeManga
        };
    }

    static fromJson(json) {
        const container = new MangaContainer();
        container.mangas = json.mangas.map(mangaJson => Manga.fromJson(mangaJson));
        container.activeManga = json.activeManga || -1;
        return container;
    }

    getCurrent() {
        if (this.activeManga >= 0 && this.activeManga < this.mangas.length) {
            return this.mangas[this.activeManga];
        }

        throw new Error('Invalid active manga index');
    }

    getSection(sectionIndex) {
        const cmanga = this.getCurrent();
        if (sectionIndex >= 0 && sectionIndex < cmanga.sections.length) {
            return cmanga.sections[sectionIndex];
        }
        throw new Error('Invalid active manga section index');
    }

}

class MangaGenerator {

    constructor() {
        this.$mangaPanel = null;
        this.mangaContainer = null;
    }

    async save() {
        setChatMetadata("mangas", this.mangaContainer.toJson(), true);
    }

    async load() {
        // Safe metadata handling when loading an uninitialized chat session
        const metadata = getChatMetadata("mangas", true);
        if (metadata) {
            this.mangaContainer = MangaContainer.fromJson(metadata);
        } else {
            this.mangaContainer = new MangaContainer();
        }
        await this.refresh();
    }

    async refresh() {
        if (!this.$mangaPanel) return;

        const $tabsContainer = this.$mangaPanel.find('.enerccio_mangagen_tabs_container');
        $tabsContainer.empty();

        // Dynamically build individual manga tabs
        this.mangaContainer.mangas.forEach((manga, index) => {
            const isActive = index === this.mangaContainer.activeManga;
            const $tab = $('<button></button>')
                .addClass('menu_button enerccio_mangagen_tab')
                .text(manga.title)
                .attr('data-index', index);

            if (isActive) {
                $tab.addClass('enerccio_mangagen_tab_active');
            }

            // Bind click to switch active workspace tab and save selection state
            $tab.on('click', async () => {
                this.mangaContainer.activeManga = index;
                await this.save();
                await this.refresh();
            });

            $tabsContainer.append($tab);
        });

        // Manage container view layouts based on item counts
        const $emptyMessage = this.$mangaPanel.find('#enerccio_mangagen_empty_message');
        if (this.mangaContainer.activeManga >= 0 && this.mangaContainer.activeManga < this.mangaContainer.mangas.length) {
            $emptyMessage.hide();
            // TODO: Inner active manga generation panel component mapping will happen here
        } else {
            $emptyMessage.show();
        }
    }

    async refreshSection(sectionIndex, throttle = false) {
        if (this.$mangaPanel) {
            const cmanga = this.mangaContainer.getCurrent();
            const genSection = cmanga.getSection(sectionIndex);

        }
    }

    async generate(sectionIndex) {
        const context = SillyTavern.getContext();
        const metadata = initializeRequestMetadata();
        const profile = metadata.cId;
        const cmanga = this.mangaContainer.getCurrent();
        const genSection = cmanga.getSection(sectionIndex);
        let prevSection = null;
        if (sectionIndex > 0) {
            prevSection = cmanga.getSection(sectionIndex - 1);
        }
        if (genSection.isGenerating()) {
            return;
        }

        genSection.setGenerating(true);
        genSection._abort = new AbortController();
        const queries = await this.generateQueryData(cmanga, genSection, prevSection);

        try {
            let asyncGeneratorFunction = await context.ConnectionManagerRequestService.sendRequest(profile, queries,
                profile.max_tokens, {stream: true, signal: genSection._abort.signal});

            let reasoningTime = null;
            let reasoningDone = false;
            const asyncGenerator = asyncGeneratorFunction();
            while (true) {
                let r = await asyncGenerator.next();
                if (r.done) {
                    genSection._abort = null;
                    break;
                }

                const returnFromGenerator = r.value;
                const text = returnFromGenerator.text;
                const reasoning = returnFromGenerator.state?.reasoning;

                if (reasoning && reasoningTime === null) {
                    reasoningTime = performance.now();
                }

                genSection.generatedText = text;

                if (text) {
                    reasoningDone = true;
                }

                if (reasoning)
                    genSection.setReasoning(reasoning, performance.now() - reasoningTime, reasoningDone);

                await this.refreshSection(sectionIndex, true);
            }
        } catch (aborted) {
            if (aborted === 'userStopped') {
                log('Query generation aborted by user');
            } else {
                error("Query generation failed: " + aborted);
            }
            genSection._abort = null;
        }

        genSection.setGenerating(false);
        await this.save();
        await this.refreshSection(sectionIndex);
    }

    async generateQueryData(cmanga, genSection, prevSection = null) {
        const context = SillyTavern.getContext();

        const queries = [];

        let {
            description,
            personality,
            persona,
            scenario,
            mesExamples,
            system,
            jailbreak,
            charDepthQuery,
            creatorNotes,
        } = getCharacterCardFields();

        if (jailbreak) {
            queries.push({
                content: jailbreak,
                role: "system",
            });
        }

        const firstMessage = getSettings("firstMessage");
        if (firstMessage)
            queries.push({
                content: firstMessage,
                role: "system",
            });

        queries.push({
            content: LORE_DENOMINATOR_START,
            role: "system",
        });

        if (system)
            queries.push({
                content: scenario,
                role: "system",
            });
        if (scenario)
            queries.push({
                content: scenario,
                role: "system",
            });
        if (persona)
            queries.push({
                content: persona,
                role: "system",
            });
        if (description)
            queries.push({
                content: description,
                role: "system",
            });
        if (personality)
            queries.push({
                content: personality,
                role: "system",
            });
        if (mesExamples)
            queries.push({
                content: mesExamples,
                role: "system",
            });

        let chatMessagesData = "";
        const count = genSection.contextStartMessage || 0;
        const countTo = genSection.contextEndMessage || context.chat.length - 1;
        const chatMessages =  context.chat;
        if (count <= countTo && count >= 0) {
            chatMessagesData = await this.getMessageContent(count, countTo);
        }

        const globalScanData = {
            personaDescription: persona,
            characterDescription: description,
            characterPersonality: personality,
            characterDepthQuery: charDepthQuery,
            scenario: scenario,
            creatorNotes: creatorNotes,
            trigger: cmanga.trigger,
        };
        let this_max_context = getMaxPromptTokens();
        const {
            worldInfoString,
            worldInfoBefore,
            worldInfoAfter,
            worldInfoExamples,
            worldInfoDepth,
            outletEntries
        } = await getWorldInfoPrompt(chatMessagesData ? [ chatMessagesData ]: [ ], this_max_context, false, globalScanData);

        if (worldInfoBefore) {
            queries.push({
                content: worldInfoBefore,
                role: "system",
            });
        }
        if (worldInfoAfter) {
            queries.push({
                content: worldInfoAfter,
                role: "system",
            });
        }


        queries.push({
            content: LORE_DENOMINATOR_END,
            role: "system",
        });

        queries.push({
            content: ```${MANGA_DENOMINATOR_START}

            ${chatMessages}

            ${MANGA_DENOMINATOR_END}```,
            role: "system",
        });

        let prompt = genSection.promptOverride || cmanga.defaultPrompt || DEFAULT_PROMPT;
        prompt = compilePromptTemplate(prompt, {
            tokenBudget: cmanga.tokenBudget || 4096,
            additionalRules: genSection.additionalRules || '',
        });

        if (genSection.startingMessage) {
            const startingMessage = context.chat[genSection.startingMessage];
            if (startingMessage) {
                prompt += `\n\nAdapt from: ${startingMessage.mes}`;
            }
        }

        if (genSection.endingMessage) {
            const endingMessage = context.chat[genSection.endingMessage];
            if (endingMessage) {
                prompt += `\n\nAdapt to (including): ${endingMessage.mes}`;
            }
        }

        if (prevSection) {
            queries.push({role: 'assistant', content: prevSection.generatedText});
        }

        queries.push({role: 'user', content: prompt});

        return queries;
    }

    async getMessageContent(from, to) {
        const context = SillyTavern.getContext();
        const messages = context.chat.slice(from, to + 1);
        return messages.map(m => m.mes).join('\n');
    }

    async open() {
        await this.load();

        // Guard against appending duplicate dialog view instances
        if ($('#enerccio_mangagen_viewer_overlay').length > 0) return;

        // Render the viewer base layout template from file path configurations
        const templateHtml = await renderExtensionTemplateAsync(
            EXTENSION_PATH,
            'viewer'
        );

        $('body').append(templateHtml);
        this.$mangaPanel = $('#enerccio_mangagen_viewer_dialog');

        // Wire Up Interactive Close Actions
        $('#enerccio_mangagen_btn_close').on('click', () => {
            $('#enerccio_mangagen_viewer_overlay').remove();
            this.$mangaPanel = null;
        });

        // Wire Up Active "Create New Manga" Triggers
        $('#enerccio_mangagen_btn_add').on('click', async () => {
            const newManga = new Manga();
            newManga.title = `Manga Script ${this.mangaContainer.mangas.length + 1}`;

            this.mangaContainer.mangas.push(newManga);
            this.mangaContainer.activeManga = this.mangaContainer.mangas.length - 1;

            await this.save();
            await this.refresh();
        });

        await this.refresh();
    }
}

const mangaGenerator = new MangaGenerator();

async function addButton() {
    const text = t`Manga Generator`;
    const iconType = 'fa-solid fa-book-open';

    const launchButton = document.createElement('div');
    launchButton.id = 'mangaGeneratorButton';
    launchButton.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    launchButton.tabIndex = 0;
    launchButton.title = text;
    const icon = document.createElement('i');
    icon.className = iconType;
    launchButton.appendChild(icon);
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    launchButton.appendChild(textSpan);

    const extensionsMenu = document.getElementById('extensionsMenu');
    extensionsMenu.classList.add('interactable');
    extensionsMenu.tabIndex = 0;

    if (!extensionsMenu) {
        throw new Error('Could not find the extensions menu');
    }

    extensionsMenu.appendChild(launchButton);
    launchButton.addEventListener('click', async () => {
        await mangaGenerator.open();
    });
}

$(async function () {
    log('Loading extension...');

    await loadSettings();
    await addButton();
});

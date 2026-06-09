import {
    compilePromptTemplate,
    error,
    getChatMetadata,
    getSettings,
    initializeRequestMetadata,
    loadSettings,
    log,
    setChatMetadata, toastDebounced,
} from "./utils.js";
import {getCharacterCardFields, getMaxPromptTokens, messageFormatting, name1, user_avatar} from "/script.js";
import {getWorldInfoPrompt} from "/scripts/world-info.js";
import {t} from "/scripts/i18n.js";
import {renderExtensionTemplateAsync} from "/scripts/extensions.js";
import {EXTENSION_PATH} from "./conf.js";
import {power_user} from "/scripts/power-user.js";
import {getOrCreatePersonaDescriptor} from "/scripts/personas.js";

const MANGA_DENOMINATOR = 'SOURCE MANUSCRIPT';
const MANGA_DENOMINATOR_START = `===== ${MANGA_DENOMINATOR} START =====`;
const MANGA_DENOMINATOR_END = `===== ${MANGA_DENOMINATOR} END =====`;
const LORE_DENOMINATOR = 'BACKGROUND LORE';
const LORE_DENOMINATOR_START = `===== ${LORE_DENOMINATOR} START =====`;
const LORE_DENOMINATOR_END = `===== ${LORE_DENOMINATOR} END =====`;

const DEFAULT_PROMPT = `You are an expert Manga Scriptwriter and Storyboard Director. Your task is to adapt the ${MANGA_DENOMINATOR} raw roleplay text into a professional, highly visual manga script formatted by pages and panels. Keep the continuation of page numbers (if any).

### Content guidelines
1. Do not ignore any story elements
2. You have {{tokenBudget}} token budget, use it
3. Do not create panels for story content you already created before
4. Use provided ${LORE_DENOMINATOR} section as a source of background lore.
5. Adapt every event.
6. Keep events in chronological order just like in ${MANGA_DENOMINATOR}.

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


const GMANGA_DENOMINATOR = 'GENERATED MANGA SCRIPT';
const GMANGA_DENOMINATOR_START = `===== ${GMANGA_DENOMINATOR} START =====`;
const GMANGA_DENOMINATOR_END = `===== ${GMANGA_DENOMINATOR} END =====`;
const DEFAULT_TAGS_PROMPT = `You are an expert AI Image Generation Prompt Engineer specializing in high-fidelity anime tagging schema (Danbooru-style tokens mixed with composition descriptors).
Your task is to analyze the provided ${MANGA_DENOMINATOR} and the corresponding ${GMANGA_DENOMINATOR}. You have {{tokenBudget}} output token budget available.

Use provided ${LORE_DENOMINATOR} section as a source of character/scene definitions.

For every panel defined in the ${GMANGA_DENOMINATOR}, output descriptive tokens and tags tailored for an AI image generator using this exact markdown layout structure:

### PAGE [ Page Number ] / PANEL [Number]
- **character: [Character Name]**: [ Danbooru tags describing physical appearance, clothing, specific expression, and exact physical pose in this frame, separated by commas. e.g., 1girl, solo, long aqua hair, blue eyes, uniform, smiling, holding sword, dynamic pose ]
- **scene**: [ Masterpiece, best quality, background object descriptions, perspective camera angles, illumination rules, and atmospheric conditions. e.g., masterpiece, best quality, dark theme, wide shot, cinematic lighting, crumbling castle ruins, night, full moon ]

Strictly stick to this structural output format. Do not write any structural setup headers, summaries, or conversational dialogue commentary.`;

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
        this.additionalRulesAddendum = null;
        this._generating = false;
        this._abort = null;

        this.tagsPromptOverride = null;
        this.tagsText = null;
        this.tagsReasoningText = null;
        this.tagsReasoningTime = null;
        this.tagsReasoningFinished = null;
        this._generatingTags = false;
        this._abortTags = null;
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
        section.additionalRulesAddendum = json.additionalRulesAddendum;
        section.contextStartMessage = json.contextStartMessage;
        section.contextEndMessage = json.contextEndMessage;

        section.tagsPromptOverride = json.tagsPromptOverride;
        section.tagsText = json.tagsText;
        section.tagsReasoningText = json.tagsReasoningText;
        section.tagsReasoningTime = json.tagsReasoningTime;
        section.tagsReasoningFinished = json.tagsReasoningFinished;
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
            additionalRulesAddendum: this.additionalRulesAddendum,
            contextStartMessage: this.contextStartMessage,
            contextEndMessage: this.contextEndMessage,

            tagsPromptOverride: this.tagsPromptOverride,
            tagsText: this.tagsText,
            tagsReasoningText: this.tagsReasoningText,
            tagsReasoningTime: this.tagsReasoningTime,
            tagsReasoningFinished: this.tagsReasoningFinished,
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

    isGeneratingTags() {
        return this._generatingTags;
    }

    setGeneratingTags(val) {
        this._generatingTags = val;
    }

    abortGeneratingTags() {
        if (this._abortTags) this._abortTags.abort();
    }

    setTagsReasoning(reasoning, reasoningTime, reasoningFinished) {
        this.tagsReasoningText = reasoning;
        if (!reasoningFinished)
            this.tagsReasoningTime = reasoningTime;
        this.tagsReasoningFinished = reasoningFinished;
    }

}

class Manga {

    constructor() {
        this.title = "Untitled"
        this.sections = [];
        this.promptOverride = getSettings("defaultPromptOverride", false, null);
        this.tagsPromptOverride = getSettings("defaultTagsPromptOverride", false, null);
        this.additionalRules = getSettings("defaultAdditionalRules", false, null);
        this.tokenBudget = parseInt(getSettings("defaultTokenBudget", false, 4096), 10);
        this.trigger = getSettings("defaultTrigger", false, 'MangaGenerator');
        this.splitCount = parseInt(getSettings("defaultSplitCount", false, 25), 10);
        this.contextLeft = parseInt(getSettings("defaultContextLeft", false, 25), 10);
        this.contextRight = parseInt(getSettings("defaultContextRight", false, 25), 10);
        this.stripCharacterNames = getSettings("defaultStripCharacterNames", false, false);
        this.stripUsername = getSettings("defaultStripUsername", false, false);
        this.alignBoundary = getSettings("defaultAlignBoundary", false, false);
    }

    toJson() {
        return {
            title: this.title,
            sections: this.sections.map(section => section.toJson()),
            promptOverride: this.promptOverride,
            tagsPromptOverride: this.tagsPromptOverride,
            additionalRules: this.additionalRules,
            tokenBudget: this.tokenBudget,
            trigger: this.trigger,
            splitCount: this.splitCount,
            contextLeft: this.contextLeft,
            contextRight: this.contextRight,
            stripCharacterNames: this.stripCharacterNames,
            stripUsername: this.stripUsername,
            alignBoundary: this.alignBoundary,
        };
    }

    static fromJson(json) {
        const manga = new Manga();
        manga.title = json.title;
        manga.sections = json.sections.map(sectionJson => MangaSection.fromJson(sectionJson));
        manga.promptOverride = json.promptOverride;
        manga.tagsPromptOverride = json.tagsPromptOverride;
        manga.additionalRules = json.additionalRules;
        manga.tokenBudget = json.tokenBudget;
        manga.trigger = json.trigger;
        manga.splitCount = json.splitCount;
        manga.contextLeft = json.contextLeft;
        manga.contextRight = json.contextRight;
        manga.stripCharacterNames = json.stripCharacterNames;
        manga.stripUsername = json.stripUsername;
        manga.alignBoundary = json.alignBoundary || false;
        return manga;
    }

    getSection(sectionIndex) {
        if (sectionIndex >= 0 && sectionIndex < this.sections.length) {
            return this.sections[sectionIndex];
        }
        throw new Error('Invalid active manga section index');
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
        return cmanga.getSection(sectionIndex);
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

        let isContainerAtBottom = false;
        let oldPanelsContainerScroll = 0;
        const sectionScrolls = [];

        const $oldPanelsContainer = this.$mangaPanel.find('#enerccio_mangagen_panels_container');
        if ($oldPanelsContainer.length) {
            oldPanelsContainerScroll = $oldPanelsContainer.scrollTop();

            const el = $oldPanelsContainer[0];
            isContainerAtBottom = (el.scrollHeight - el.scrollTop <= el.clientHeight + 30);

            $oldPanelsContainer.find('.enerccio_mangagen_section_row').each(function() {
                const idx = parseInt($(this).attr('data-index'), 10);
                if (!isNaN(idx)) {
                    sectionScrolls[idx] = {
                        viewScroll: $(this).find('.enerccio_mangagen_section_generated_view').scrollTop(),
                        reasoningScroll: $(this).find('.enerccio_mangagen_reasoning').scrollTop(),
                        tagsViewScroll: $(this).find('.enerccio_mangagen_section_tags_view').scrollTop(),
                        tagsReasoningScroll: $(this).find('.enerccio_mangagen_tags_reasoning').scrollTop(),
                        isTagsMode: $(this).find('.enerccio_mangagen_section_btn_tags_toggle').hasClass('active-mode')
                    };
                }
            });
        }

        const $tabsContainer = this.$mangaPanel.find('.enerccio_mangagen_tabs_container');
        $tabsContainer.empty();

        // Dynamically build individual manga tabs
        this.mangaContainer.mangas.forEach((manga, index) => {
            const isActive = index === this.mangaContainer.activeManga;

            // Changed from <button> to <div> to support nesting the interactive rename textfield
            const $tab = $('<div></div>')
                .addClass('menu_button enerccio_mangagen_tab')
                .attr('data-index', index)
                .attr('draggable', 'true');

            if (isActive) {
                $tab.addClass('enerccio_mangagen_tab_active');
            }

            // Inner title text holder
            const $titleSpan = $('<span></span>')
                .addClass('enerccio_mangagen_tab_title')
                .text(manga.title);
            $tab.append($titleSpan);

            // Drag and drop event handlers to reorder tabs
            $tab.on('dragstart', (e) => {
                e.originalEvent.dataTransfer.setData('text/plain', index.toString());
                $tab.addClass('dragging');
            });

            $tab.on('dragover', (e) => {
                e.preventDefault(); // Required to allow a drop
                $tab.addClass('drag-over');
            });

            $tab.on('dragleave', () => {
                $tab.removeClass('drag-over');
            });

            $tab.on('drop', async (e) => {
                e.preventDefault();
                $tab.removeClass('drag-over');
                const dragIndex = parseInt(e.originalEvent.dataTransfer.getData('text/plain'), 10);
                if (!isNaN(dragIndex) && dragIndex !== index) {
                    const targetIndex = index;

                    // Reorder the array
                    const draggedManga = this.mangaContainer.mangas[dragIndex];
                    this.mangaContainer.mangas.splice(dragIndex, 1);
                    this.mangaContainer.mangas.splice(targetIndex, 0, draggedManga);

                    // Keep active selection pointer aligned with original selected item position
                    if (this.mangaContainer.activeManga === dragIndex) {
                        this.mangaContainer.activeManga = targetIndex;
                    } else if (this.mangaContainer.activeManga > dragIndex && this.mangaContainer.activeManga <= targetIndex) {
                        this.mangaContainer.activeManga--;
                    } else if (this.mangaContainer.activeManga < dragIndex && this.mangaContainer.activeManga >= targetIndex) {
                        this.mangaContainer.activeManga++;
                    }

                    await this.save();
                    await this.refresh();
                }
            });

            $tab.on('dragend', () => {
                $tab.removeClass('dragging');
            });

            // Bind the inline rename function to the active tab
            if (isActive) {
                const $renameBtn = $('<i></i>')
                    .addClass('fa-solid fa-pen enerccio_mangagen_rename_btn')
                    .attr('title', 'Rename Manga');

                $renameBtn.on('click', (e) => {
                    e.stopPropagation(); // Prevent tab selection logic from refiring

                    const $input = $('<input type="text" />')
                        .addClass('text_pole')
                        .val(manga.title)
                        .css({
                            'width': '100px',
                            'height': '20px',
                            'padding': '2px',
                            'margin': '0',
                            'font-size': 'inherit'
                        });

                    // Swap the elements out
                    $titleSpan.hide();
                    $renameBtn.hide();
                    $tab.append($input);
                    $input.focus().select();

                    // Universal rename commit logic
                    let isSaving = false;
                    const saveRename = async () => {
                        if (isSaving) return;
                        isSaving = true;

                        const newTitle = $input.val().trim();
                        if (newTitle && newTitle !== manga.title) {
                            manga.title = newTitle;
                            await this.save();
                        }
                        await this.refresh();
                    };

                    // Save on leaving the textbox
                    $input.on('blur', async () => {
                        await saveRename();
                    });

                    // Save on hitting Enter
                    $input.on('keydown', (ev) => {
                        if (ev.key === 'Enter') {
                            ev.preventDefault();
                            $input.trigger('blur');
                        }
                    });
                });

                $tab.append($renameBtn);
            }

            // Bind click to switch active workspace tab and save selection state
            $tab.on('click', async (e) => {
                // Ignore clicks if they are interacting with the textfield or the pen icon
                if ($(e.target).closest('input, .enerccio_mangagen_rename_btn').length > 0) return;

                this.mangaContainer.activeManga = index;
                await this.save();
                await this.refresh();
            });

            $tabsContainer.append($tab);
        });

        // Manage container view layouts based on item counts
        // Manage container view layouts based on item counts
        const $emptyMessage = this.$mangaPanel.find('#enerccio_mangagen_empty_message');
        const $contentArea = this.$mangaPanel.find('#enerccio_mangagen_content_area');

        // Clear out any previously active workspace DOM branches before rebuilding
        $contentArea.find('.enerccio_mangagen_workspace').remove();

        if (this.mangaContainer.activeManga >= 0 && this.mangaContainer.activeManga < this.mangaContainer.mangas.length) {
            $emptyMessage.hide();

            // Asynchronously fetch and render the workspace elements template
            const workspaceHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'manga');
            $contentArea.append(workspaceHtml);

            const cmanga = this.mangaContainer.getCurrent();
            const $workspace = $contentArea.find('.enerccio_mangagen_workspace');

            // Wire up Token Budget Input (Min: 512)
            const $tokenBudget = $workspace.find('#manga_token_budget');
            $tokenBudget.val(cmanga.tokenBudget);
            $tokenBudget.on('change input', async () => {
                const val = parseInt($tokenBudget.val(), 10);
                if (!isNaN(val) && val >= 512) {
                    cmanga.tokenBudget = val;
                    await this.save();
                }
            });

            // Wire up World Info Trigger Dropdown Options
            const $trigger = $workspace.find('#manga_trigger');
            $trigger.val(cmanga.trigger || 'MangaGenerator');
            $trigger.on('change', async () => {
                cmanga.trigger = $trigger.val();
                await this.save();
            });

            // Wire up Split Message Count Input (Min: 1)
            const $splitCount = $workspace.find('#manga_split_count');
            $splitCount.val(cmanga.splitCount);
            $splitCount.on('change input', async () => {
                const val = parseInt($splitCount.val(), 10);
                if (!isNaN(val) && val >= 1) {
                    cmanga.splitCount = val;
                    await this.save();
                }
            });

            // Wire up Number of Context Messages Before Input (Min: 0)
            const $contextLeft = $workspace.find('#manga_context_left');
            $contextLeft.val(cmanga.contextLeft);
            $contextLeft.on('change input', async () => {
                const val = parseInt($contextLeft.val(), 10);
                if (!isNaN(val) && val >= 0) {
                    cmanga.contextLeft = val;
                    await this.save();
                }
            });

            // Wire up Number of Context Messages After Input (Min: 0)
            const $contextRight = $workspace.find('#manga_context_right');
            $contextRight.val(cmanga.contextRight);
            $contextRight.on('change input', async () => {
                const val = parseInt($contextRight.val(), 10);
                if (!isNaN(val) && val >= 0) {
                    cmanga.contextRight = val;
                    await this.save();
                }
            });

            const $stripCharNames = $workspace.find('#manga_strip_char_names');
            $stripCharNames.prop('checked', cmanga.stripCharacterNames);
            $stripCharNames.on('change', async () => {
                cmanga.stripCharacterNames = $stripCharNames.prop('checked');
                await this.save();
            });

            // Wire up Strip Username Configuration Checkbox
            const $stripUsername = $workspace.find('#manga_strip_username');
            $stripUsername.prop('checked', cmanga.stripUsername);
            $stripUsername.on('change', async () => {
                cmanga.stripUsername = $stripUsername.prop('checked');
                await this.save();
            });

            // Wire up Align Persona-Response Boundary Checkbox
            const $alignBoundary = $workspace.find('#manga_align_boundary');
            $alignBoundary.prop('checked', cmanga.alignBoundary);
            $alignBoundary.on('change', async () => {
                cmanga.alignBoundary = $alignBoundary.prop('checked');
                await this.save();
            });

            // Prompt Override Popup Handling Logic
            const $promptPanel = $workspace.find('#manga_prompt_override_panel');
            const $promptTextArea = $workspace.find('#manga_prompt_override');
            const $btnPromptOverride = $workspace.find('#manga_btn_prompt_override');
            const $btnClosePrompt = $workspace.find('#manga_btn_close_prompt');

            $btnPromptOverride.on('click', () => {
                // If null or unassigned, fall back to displaying the base DEFAULT_PROMPT configuration
                $promptTextArea.val(cmanga.promptOverride !== null ? cmanga.promptOverride : DEFAULT_PROMPT);
                $promptPanel.toggle();
            });

            $btnClosePrompt.on('click', () => {
                $promptPanel.hide();
            });

            $promptTextArea.on('change input', async () => {
                cmanga.promptOverride = $promptTextArea.val() || null;
                await this.save();
            });

            const $tagsPromptPanel = $workspace.find('#manga_tags_prompt_override_panel');
            const $tagsPromptTextArea = $workspace.find('#manga_tags_prompt_override');
            const $btnTagsPromptOverride = $workspace.find('#manga_btn_tags_prompt_override');
            const $btnCloseTagsPrompt = $workspace.find('#manga_btn_close_tags_prompt');

            $btnTagsPromptOverride.on('click', () => {
                $tagsPromptTextArea.val(cmanga.tagsPromptOverride !== null ? cmanga.tagsPromptOverride : DEFAULT_TAGS_PROMPT);
                $tagsPromptPanel.toggle();
            });

            $btnCloseTagsPrompt.on('click', () => {
                $tagsPromptPanel.hide();
            });

            $tagsPromptTextArea.on('change input', async () => {
                cmanga.tagsPromptOverride = $tagsPromptTextArea.val() || null;
                await this.save();
            });

            // Additional Rules Popup Handling Logic
            const $rulesPanel = $workspace.find('#manga_additional_rules_panel');
            const $rulesTextArea = $workspace.find('#manga_additional_rules');
            const $btnAdditionalRules = $workspace.find('#manga_btn_additional_rules');
            const $btnCloseRules = $workspace.find('#manga_btn_close_rules');

            $btnAdditionalRules.on('click', () => {
                $rulesTextArea.val(cmanga.additionalRules !== null ? cmanga.additionalRules : '');
                $rulesPanel.toggle();
            });

            $btnCloseRules.on('click', () => {
                $rulesPanel.hide();
            });

            $rulesTextArea.on('change input', async () => {
                cmanga.additionalRules = $rulesTextArea.val() || null;
                await this.save();
            });

            // Wire up the Copy All Panels and Tags Content Trigger
            const $btnCopyAll = $workspace.find('#manga_btn_copy_all');
            $btnCopyAll.on('click', () => {
                const panelsText = cmanga.sections
                    .map(section => section.generatedText || '')
                    .filter(text => text.trim() !== '')
                    .join('\n\n');

                const tagsText = cmanga.sections
                    .map(section => section.tagsText || '')
                    .filter(text => text.trim() !== '')
                    .join('\n\n');

                let combinedOutput = panelsText;
                if (tagsText) {
                    combinedOutput += (combinedOutput ? '\n\n' : '') + tagsText;
                }

                if (!combinedOutput.trim()) {
                    toastDebounced("No generated storyboard or tags content found to copy.", "warning");
                    return;
                }

                navigator.clipboard.writeText(combinedOutput).then(() => {
                    toastDebounced("All storyboard panels and tags copied to clipboard!");
                }).catch((err) => {
                    console.error('Failed to copy all content: ', err);
                    alert('Could not copy content to clipboard.');
                });
            });

            // Wire up the Add Panel Automation Trigger using native attributes
            const $btnAddPanel = $workspace.find('#manga_btn_add_panel');
            $btnAddPanel.on('click', async () => {
                const chatLog = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext().chat : (window.chat || []);

                if (!chatLog || chatLog.length === 0) {
                    if (typeof toastr !== 'undefined') {
                        toastr.error("Cannot create a panel because the current chat log contains no messages.");
                    } else {
                        alert("Error: The current chat log contains no messages.");
                    }
                    return;
                }

                let startingMsg = 0;

                // Derive the tracking start coordinates from the last block's endingMessage attribute
                if (cmanga.sections && cmanga.sections.length > 0) {
                    const lastSection = cmanga.sections[cmanga.sections.length - 1];
                    startingMsg = (lastSection.endingMessage ?? 0) + 1;
                }

                if (startingMsg >= chatLog.length) {
                    if (typeof toastr !== 'undefined') {
                        toastr.error(`No new messages available for a new panel. (Index ${startingMsg} exceeds chat length ${chatLog.length})`);
                    } else {
                        alert(`Error: No new messages available for a new panel. (Index ${startingMsg} matches or exceeds chat length)`);
                    }
                    return;
                }

                const splitOffset = cmanga.splitCount || 25;
                let endingMsg = startingMsg + splitOffset;

                if (endingMsg >= chatLog.length) {
                    endingMsg = chatLog.length - 1;
                }

                // Check if endingMsg is a user message and back it up by 1 if requested
                if (cmanga.alignBoundary && endingMsg > startingMsg) {
                    const lastMsg = chatLog[endingMsg];
                    if (lastMsg && lastMsg.is_user) {
                        endingMsg--;
                    }
                }

                // Initialize class instance using native parameters
                const newSection = new MangaSection();
                newSection.startingMessage = startingMsg;
                newSection.endingMessage = endingMsg;

                // Read context values directly as numbers
                const leftContext = cmanga.contextLeft ?? 0;
                const rightContext = cmanga.contextRight ?? 0;

                newSection.contextStartMessage = Math.max(0, startingMsg - leftContext);
                newSection.contextEndMessage = Math.min(chatLog.length - 1, endingMsg + rightContext);
                newSection.generatedText = "";

                cmanga.sections.push(newSection);
                await this.save();
                await this.refresh();
            });

            // Locate the template workspace section block and instantiate child frames
            const $panelsContainer = $workspace.find('#enerccio_mangagen_panels_container');
            $panelsContainer.empty();

            const sectionHtmlTemplate = await renderExtensionTemplateAsync(EXTENSION_PATH, 'section');

            // Construct row layers for each assigned partition sequence inside the manga instance
            if (cmanga.sections && cmanga.sections.length > 0) {
                for (let index = 0; index < cmanga.sections.length; index++) {
                    const section = cmanga.sections[index];
                    const $row = $(sectionHtmlTemplate);

                    $row.attr('id', `mangagen_section_${index}`);
                    $row.attr('data-index', index);

                    // Context and message input change listeners tracking native constructor schemas
                    $row.find('.enerccio_mangagen_section_ctx_from').on('change input', async (e) => {
                        section.contextStartMessage = parseInt($(e.target).val(), 10) || 0;
                        await this.save();
                    });
                    $row.find('.enerccio_mangagen_section_ctx_to').on('change input', async (e) => {
                        section.contextEndMessage = parseInt($(e.target).val(), 10) || 0;
                        await this.save();
                    });
                    $row.find('.enerccio_mangagen_section_msg_from').on('change input', async (e) => {
                        section.startingMessage = parseInt($(e.target).val(), 10) || 0;
                        await this.save();
                    });
                    $row.find('.enerccio_mangagen_section_msg_to').on('change input', async (e) => {
                        section.endingMessage = parseInt($(e.target).val(), 10) || 0;
                        await this.save();
                    });

                    // Wiring up the diagnostic messaging log popover inspection rule (Awaiting async getter)
                    $row.find('.enerccio_mangagen_section_btn_info').on('click', async (e) => {
                        e.stopPropagation();
                        $('.enerccio_mangagen_popover').remove();

                        const fromIdx = section.startingMessage ?? 0;
                        const toIdx = section.endingMessage ?? 0;

                        // Properly awaiting the async helper method defined on the class instance
                        let output = await this.getMessageContent(fromIdx, toIdx);

                        if (!output || output.trim() === "") {
                            output = "No active data frames indexed across this boundary interval.";
                        }

                        const $popover = $('<div class="enerccio_mangagen_popover"></div>');
                        const $closeBtn = $('<i class="fa-solid fa-xmark enerccio_mangagen_popover_close" title="Close"></i>');
                        const $content = $('<div class="enerccio_mangagen_popover_content"></div>').text(output);

                        $popover.append($closeBtn).append($content);
                        $('body').append($popover);

                        const $btn = $(e.currentTarget);
                        const btnOffset = $btn.offset();
                        const btnHeight = $btn.outerHeight();

                        $popover.css({
                            top: btnOffset.top + btnHeight + 6,
                            left: Math.max(15, btnOffset.left - 260)
                        });

                        $closeBtn.on('click', () => $popover.remove());

                        const dismissPopover = (event) => {
                            if (!$(event.target).closest('.enerccio_mangagen_popover').length) {
                                $popover.remove();
                                $(document).off('click', dismissPopover);
                            }
                        };
                        setTimeout(() => $(document).on('click', dismissPopover), 20);

                        $row.find('.enerccio_mangagen_reasoning_details').on('toggle', (e) => {
                            const isOpen = e.target.open;
                            $(e.target).find('.enerccio_mangagen_reasoning_arrow')
                                .toggleClass('fa-chevron-down', !isOpen)
                                .toggleClass('fa-chevron-up', isOpen);
                        });
                    });

                    const $allDropdownPanels = $row.find('.enerccio_mangagen_section_toggle_panel');

                    // Prompt overrides section submenus bindings
                    const $promptPanel = $row.find('.enerccio_mangagen_section_prompt_panel');
                    const $promptInput = $row.find('.enerccio_mangagen_section_prompt_override');
                    $row.find('.enerccio_mangagen_section_btn_prompt').on('click', (e) => {
                        e.stopPropagation();
                        $promptInput.val(section.promptOverride || '');
                        const wasVisible = $promptPanel.is(':visible');
                        $allDropdownPanels.hide(); // Hide any other open dropdowns first
                        if (!wasVisible) $promptPanel.show();
                    });
                    $promptInput.on('change input', async () => {
                        section.promptOverride = $promptInput.val() || null;
                        await this.save();
                    });

                    const $tagsPromptPanel = $row.find('.enerccio_mangagen_section_tags_prompt_panel');
                    const $tagsPromptInput = $row.find('.enerccio_mangagen_section_tags_prompt_override');
                    $row.find('.enerccio_mangagen_section_btn_tags_prompt').on('click', (e) => {
                        e.stopPropagation();
                        $tagsPromptInput.val(section.tagsPromptOverride || '');
                        const wasVisible = $tagsPromptPanel.is(':visible');
                        $allDropdownPanels.hide(); // Hide any other open dropdowns first
                        if (!wasVisible) $tagsPromptPanel.show();
                    });

                    $tagsPromptInput.on('change input', async () => {
                        section.tagsPromptOverride = $tagsPromptInput.val() || null;
                        await this.save();
                    });

                    // Additional configuration criteria boundaries bindings
                    const $rulesPanel = $row.find('.enerccio_mangagen_section_rules_panel');
                    const $rulesInput = $row.find('.enerccio_mangagen_section_additional_rules');
                    $row.find('.enerccio_mangagen_section_btn_rules').on('click', (e) => {
                        e.stopPropagation();
                        $rulesInput.val(section.additionalRules || '');
                        const wasVisible = $rulesPanel.is(':visible');
                        $allDropdownPanels.hide(); // Hide any other open dropdowns first
                        if (!wasVisible) $rulesPanel.show();
                    });
                    $rulesInput.on('change input', async () => {
                        section.additionalRules = $rulesInput.val() || null;
                        await this.save();
                    });

                    const $addendumPanel = $row.find('.enerccio_mangagen_section_addendum_panel');
                    const $addendumInput = $row.find('.enerccio_mangagen_section_additional_rules_addendum');
                    $row.find('.enerccio_mangagen_section_btn_addendum').on('click', (e) => {
                        e.stopPropagation();
                        $addendumInput.val(section.additionalRulesAddendum || '');
                        const wasVisible = $addendumPanel.is(':visible');
                        $allDropdownPanels.hide(); // Hide any other open dropdowns first
                        if (!wasVisible) $addendumPanel.show();
                    });
                    $addendumInput.on('change input', async () => {
                        section.additionalRulesAddendum = $addendumInput.val() || null;
                        await this.save();
                    });

                    const dismissOpenDropdowns = (event) => {
                        if (!$(event.target).closest('.enerccio_mangagen_section_toggle_panel, .enerccio_mangagen_section_btn_prompt, .enerccio_mangagen_section_btn_rules, .enerccio_mangagen_section_btn_addendum, .enerccio_mangagen_section_btn_tags_prompt').length) {
                            $allDropdownPanels.hide();
                        }
                    };
                    $(document).off('click', dismissOpenDropdowns).on('click', dismissOpenDropdowns);

                    const $viewDiv = $row.find('.enerccio_mangagen_section_generated_view');
                    const $editArea = $row.find('.enerccio_mangagen_section_generated_edit');

                    // Click markdown view to open raw text editing panel
                    $viewDiv.on('click', () => {
                        if (section.isGenerating()) return; // Lock adjustments during streaming
                        $viewDiv.hide();
                        $editArea.show().focus();
                    });

                    // Leaving the textarea converts text back into clean Markdown
                    $editArea.on('blur', async () => {
                        section.generatedText = $editArea.val();
                        $editArea.hide();
                        $viewDiv.show();
                        await this.save();
                        await this.refreshSection($row, section);
                    });

                    // Keep data model updated with live typing strokes
                    $editArea.on('input', () => {
                        section.generatedText = $editArea.val();
                    });

                    // Combined execution pipeline dispatch action hook
                    $row.find('.enerccio_mangagen_section_btn_generate').on('click', async () => {
                        const isTagsActive = !$row.find('.enerccio_mangagen_layout_tags').hasClass('hidden');
                        if (isTagsActive) {
                            if (section.isGeneratingTags()) {
                                section.abortGeneratingTags();
                            } else {
                                await this.generateTags($row, index);
                            }
                        } else {
                            if (section.isGenerating()) {
                                section.abortGenerating();
                            } else {
                                await this.generate($row, index);
                            }
                        }
                    });
                    // Wire up the delete button trigger action
                    $row.find('.enerccio_mangagen_section_btn_delete').on('click', async () => {
                        // Display a standard browser confirmation dialog before destructive removal
                        if (confirm(`Are you sure you want to delete Panel Section #${index + 1}?`)) {
                            // Splice out the target panel from the array using its current index coordinate
                            cmanga.sections.splice(index, 1);

                            // Persist changes to chat metadata and trigger full layout redraw
                            await this.save();
                            await this.refresh();
                        }
                    });

                    // Wire up the copy button trigger action
                    $row.find('.enerccio_mangagen_section_btn_copy').on('click', () => {
                        const isTagsActive = !$tagsLayout.hasClass('hidden');
                        const textToCopy = isTagsActive ? (section.tagsText || '') : (section.generatedText || '');

                        navigator.clipboard.writeText(textToCopy).then(() => {
                            toastDebounced(`${isTagsActive ? 'Tags' : 'Panel Script'} #${index + 1} copied!`);
                        }).catch((err) => {
                            console.error('Failed to copy text: ', err);
                            alert('Could not copy text to clipboard.');
                        });
                    });

                    const $tagsPanel = $row.find('.enerccio_mangagen_section_tags_panel');
                    $row.find('.enerccio_mangagen_section_btn_tags_toggle').on('click', () => {
                        $tagsPanel.toggle();
                    });

                    const $tagsView = $row.find('.enerccio_mangagen_section_tags_view');
                    const $tagsEdit = $row.find('.enerccio_mangagen_section_tags_edit');

                    $tagsView.on('click', () => {
                        if (section.isGeneratingTags()) return;
                        $tagsView.hide();
                        $tagsEdit.show().focus();
                    });

                    $tagsEdit.on('blur', async () => {
                        section.tagsText = $tagsEdit.val();
                        $tagsEdit.hide();
                        $tagsView.show();
                        await this.save();
                        await this.refreshSection($row, section);
                    });

                    $tagsEdit.on('input', () => {
                        section.tagsText = $tagsEdit.val();
                    });

                    $row.find('.enerccio_mangagen_tags_reasoning_details').on('toggle', (e) => {
                        const isOpen = e.target.open;
                        $(e.target).find('.enerccio_mangagen_reasoning_arrow')
                            .toggleClass('fa-chevron-down', !isOpen)
                            .toggleClass('fa-chevron-up', isOpen);
                    });

                    const $toggleBtn = $row.find('.enerccio_mangagen_section_btn_tags_toggle');
                    const $scriptLayout = $row.find('.enerccio_mangagen_layout_script');
                    const $tagsLayout = $row.find('.enerccio_mangagen_layout_tags');

                    $toggleBtn.on('click', async () => {
                        const showTags = $tagsLayout.hasClass('hidden');
                        if (showTags) {
                            $scriptLayout.addClass('hidden');
                            $tagsLayout.removeClass('hidden');
                            $toggleBtn.addClass('active-mode').text('Script');
                        } else {
                            $tagsLayout.addClass('hidden');
                            $scriptLayout.removeClass('hidden');
                            $toggleBtn.removeClass('active-mode').text('Tags');
                        }
                        await this.refreshSection($row, section);
                    });

                    $panelsContainer.append($row);
                    await this.refreshSection($row, section);

                    if (sectionScrolls[index]) {
                        $row.find('.enerccio_mangagen_section_generated_view').scrollTop(sectionScrolls[index].viewScroll);
                        $row.find('.enerccio_mangagen_reasoning').scrollTop(sectionScrolls[index].reasoningScroll);
                        $row.find('.enerccio_mangagen_section_tags_view').scrollTop(sectionScrolls[index].tagsViewScroll);
                        $row.find('.enerccio_mangagen_tags_reasoning').scrollTop(sectionScrolls[index].tagsReasoningScroll);
                    }

                    if (sectionScrolls[index] && sectionScrolls[index].isTagsMode) {
                        $scriptLayout.addClass('hidden');
                        $tagsLayout.removeClass('hidden');
                        $toggleBtn.addClass('active-mode').text('Script');
                    }
                }
            } else {
                $panelsContainer.append('<div class="enerccio_mangagen_no_sections_fallback">No layout partitions built for this manga yet. Append section segments to begin generating.</div>');
            }

            if (isContainerAtBottom) {
                // If they were at the bottom, snap down to reveal the newly appended panel
                $panelsContainer.scrollTop($panelsContainer[0].scrollHeight);
            } else if (oldPanelsContainerScroll > 0) {
                // If they manually scrolled up somewhere, leave them exactly where they were
                $panelsContainer.scrollTop(oldPanelsContainerScroll);
            }
        } else {
            $emptyMessage.show();
        }
    }

    /**
     * Refreshes and updates the active input display values for a targeted section row component.
     * @param {jQuery} $row The jQuery reference object pointing to the mapped row container.
     * @param {MangaSection} section The raw data container layer model instance.
     * @param {boolean} staggered If true, throttles DOM updates to prevent lag during active token streaming.
     */
    async refreshSection($row, section, staggered = false) {
        if (!$row || !section) return;

        const performUpdate = () => {
            const isGenerating = section.isGenerating();
            const isGeneratingTags = section.isGeneratingTags();

            $row.find('.enerccio_mangagen_section_ctx_from').val(section.contextStartMessage ?? 0);
            $row.find('.enerccio_mangagen_section_ctx_to').val(section.contextEndMessage ?? 0);
            $row.find('.enerccio_mangagen_section_msg_from').val(section.startingMessage ?? 0);
            $row.find('.enerccio_mangagen_section_msg_to').val(section.endingMessage ?? 0);

            const $viewDiv = $row.find('.enerccio_mangagen_section_generated_view');
            const $editArea = $row.find('.enerccio_mangagen_section_generated_edit');
            const $reasoningDiv = $row.find('.enerccio_mangagen_reasoning');

            const viewEl = $viewDiv[0];
            const reasoningEl = $reasoningDiv[0];

            const currentViewScroll = viewEl ? viewEl.scrollTop : 0;
            const currentReasoningScroll = reasoningEl ? reasoningEl.scrollTop : 0;

            const isViewAtBottom = viewEl ? (viewEl.scrollHeight - viewEl.scrollTop <= viewEl.clientHeight + 15) : false;
            const isReasoningAtBottom = reasoningEl ? (reasoningEl.scrollHeight - reasoningEl.scrollTop <= reasoningEl.clientHeight + 15) : false;

            // --- 1. DYNAMIC SCRIPT VIEW PLACEHOLDER ---
            if (!$editArea.is(':focus')) {
                let text = section.generatedText || '';
                if (!text && isGenerating) {
                    // Show animated loader if it's actively thinking/generating the script
                    $viewDiv.html('<p style="opacity: 0.6; font-style: italic; margin: 0;"><i class="fa-solid fa-spinner fa-spin" style="margin-right: 8px;"></i>Generating script storyboard content... Please wait.</p>');
                } else {
                    let formattedText = messageFormatting(text, '', true, false, -1);
                    $viewDiv.html(formattedText || '<p style="opacity: 0.5; font-style: italic; margin: 0;">No content generated yet. Click here to edit or run generation...</p>');
                }
                $editArea.val(text);
            }

            const $detailsBlock = $row.find('.enerccio_mangagen_reasoning_details');
            if (section.reasoningText && section.reasoningText.trim() !== '') {
                $detailsBlock.show();
                let data = section.reasoningText;
                data = messageFormatting(data, '', true, false, -1, null, true);

                if (reasoningEl) {
                    reasoningEl.innerHTML = data;
                }

                const trackingTimeMs = section.reasoningTime ?? 0;
                const elapsedSeconds = (trackingTimeMs / 1000).toFixed(1);
                const statusLabel = section.reasoningFinished ? `Thought for ${elapsedSeconds} s` : `Thinking for ${elapsedSeconds} s`;
                $row.find('.enerccio_mangagen_reasoning_text_label').text(statusLabel);
            } else {
                $detailsBlock.hide();
            }

            if (isViewAtBottom && viewEl) {
                viewEl.scrollTop = viewEl.scrollHeight;
            } else if (viewEl) {
                viewEl.scrollTop = currentViewScroll;
            }

            if (isReasoningAtBottom && reasoningEl) {
                reasoningEl.scrollTop = reasoningEl.scrollHeight;
            } else if (reasoningEl) {
                reasoningEl.scrollTop = currentReasoningScroll;
            }

            // --- 2. DYNAMIC TAGS VIEW PLACEHOLDER ---
            const $tagsView = $row.find('.enerccio_mangagen_section_tags_view');
            const $tagsEdit = $row.find('.enerccio_mangagen_section_tags_edit');
            const $tagsReasoningDiv = $row.find('.enerccio_mangagen_tags_reasoning');

            const tagsViewEl = $tagsView[0];
            const tagsReasoningEl = $tagsReasoningDiv[0];

            const currentTagsViewScroll = tagsViewEl ? tagsViewEl.scrollTop : 0;
            const currentTagsReasoningScroll = tagsReasoningEl ? tagsReasoningEl.scrollTop : 0;

            const isTagsViewAtBottom = tagsViewEl ? (tagsViewEl.scrollHeight - tagsViewEl.scrollTop <= tagsViewEl.clientHeight + 15) : false;
            const isTagsReasoningAtBottom = tagsReasoningEl ? (tagsReasoningEl.scrollHeight - tagsReasoningEl.scrollTop <= tagsReasoningEl.clientHeight + 15) : false;

            if (!$tagsEdit.is(':focus')) {
                let tagsText = section.tagsText || '';
                if (!tagsText && isGeneratingTags) {
                    // Show animated loader if it's actively thinking/generating the image tags
                    $tagsView.html('<p style="opacity: 0.6; font-style: italic; margin: 0;"><i class="fa-solid fa-spinner fa-spin" style="margin-right: 8px;"></i>Analyzing script context and compiling image tags... Please wait.</p>');
                } else {
                    let formattedTagsText = messageFormatting(tagsText, '', true, false, -1);
                    $tagsView.html(formattedTagsText || '<p style="opacity: 0.5; font-style: italic; margin: 0;">No tags generated yet. Click here to edit or run tag generation...</p>');
                }
                $tagsEdit.val(tagsText);
            }

            const $tagsDetailsBlock = $row.find('.enerccio_mangagen_tags_reasoning_details');
            if (section.tagsReasoningText && section.tagsReasoningText.trim() !== '') {
                $tagsDetailsBlock.show();
                let tagsData = section.tagsReasoningText;
                tagsData = messageFormatting(tagsData, '', true, false, -1, null, true);

                if (tagsReasoningEl) {
                    tagsReasoningEl.innerHTML = tagsData;
                }

                const trackingTagsTimeMs = section.tagsReasoningTime ?? 0;
                const elapsedTagsSeconds = (trackingTagsTimeMs / 1000).toFixed(1);
                const tagsStatusLabel = section.tagsReasoningFinished ? `Thought for ${elapsedTagsSeconds} s` : `Thinking for ${elapsedTagsSeconds} s`;
                $row.find('.enerccio_mangagen_tags_text_label').text(tagsStatusLabel);
            } else {
                $tagsDetailsBlock.hide();
            }

            if (isTagsViewAtBottom && tagsViewEl) {
                tagsViewEl.scrollTop = tagsViewEl.scrollHeight;
            } else if (tagsViewEl) {
                tagsViewEl.scrollTop = currentTagsViewScroll;
            }

            if (isTagsReasoningAtBottom && tagsReasoningEl) {
                tagsReasoningEl.scrollTop = tagsReasoningEl.scrollHeight;
            } else if (tagsReasoningEl) {
                tagsReasoningEl.scrollTop = currentTagsReasoningScroll;
            }

            $row.find('input, .enerccio_mangagen_section_btn_info, .enerccio_mangagen_section_btn_prompt, .enerccio_mangagen_section_btn_rules, .enerccio_mangagen_section_btn_addendum, .enerccio_mangagen_section_btn_tags_prompt, .enerccio_mangagen_section_btn_tags_toggle, .enerccio_mangagen_section_btn_delete, .enerccio_mangagen_section_btn_copy')
                .prop('disabled', isGenerating || isGeneratingTags);

            if (isGenerating) {
                $editArea.hide();
                $viewDiv.show();
            }
            if (isGeneratingTags) {
                $tagsEdit.hide();
                $tagsView.show();
            }

            // --- 3. MERGED GENERATION BUTTON STATE UPDATES ---
            const $genBtn = $row.find('.enerccio_mangagen_section_btn_generate');
            const isTagsActive = !$row.find('.enerccio_mangagen_layout_tags').hasClass('hidden');

            if (isTagsActive) {
                if (isGeneratingTags) {
                    $genBtn.html('<i class="fa-solid fa-ban"></i> Abort Tag Gen').addClass('aborting');
                } else {
                    $genBtn.html('<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Tags').removeClass('aborting');
                }
            } else {
                if (isGenerating) {
                    $genBtn.html('<i class="fa-solid fa-ban"></i> Abort Generation').addClass('aborting');
                } else {
                    $genBtn.html('<i class="fa-solid fa-wand-magic-sparkles"></i> Run Generation').removeClass('aborting');
                }
            }
        };

        // Extract any scheduled timeout pointer stored on the row node
        let currentTimeout = $row.data('refresh-timeout');

        if (staggered) {
            if (!currentTimeout) {
                currentTimeout = setTimeout(() => {
                    $row.removeData('refresh-timeout');
                    performUpdate();
                }, 150);
                $row.data('refresh-timeout', currentTimeout);
            }
        } else {
            if (currentTimeout) {
                clearTimeout(currentTimeout);
                $row.removeData('refresh-timeout');
            }
            performUpdate();
        }
    }

    async generate($initialRow, sectionIndex) {
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

        const getLiveRow = () => {
            const $live = this.$mangaPanel ? this.$mangaPanel.find(`#mangagen_section_${sectionIndex}`) : null;
            return ($live && $live.length) ? $live : $initialRow;
        };

        genSection.setGenerating(true);
        genSection._abort = new AbortController();

        try {
            await this.refreshSection(getLiveRow(), genSection);
            const queries = await this.generateQueryData(cmanga, genSection, prevSection);

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

                await this.refreshSection(getLiveRow(), genSection, true);
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
        await this.refreshSection(getLiveRow(), genSection);
    }

    async generateQueryData(cmanga, genSection, prevSection = null) {
        const context = SillyTavern.getContext();

        const queries = [];

        const userName = name1 || '';
        let userDescription = power_user.persona_description || '';

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

        if (userName && userDescription) {
            queries.push({
                content: `${userName}: ${userDescription}`,
                role: "system"
            });
        }

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
            content: `${MANGA_DENOMINATOR_START}

            ${chatMessagesData}

            ${MANGA_DENOMINATOR_END}`,
            role: "system",
        });

        let prompt = genSection.promptOverride || cmanga.promptOverride || DEFAULT_PROMPT;
        let sectionRules = genSection.additionalRules || cmanga.additionalRules || '';
        if (genSection.additionalRulesAddendum) {
            sectionRules += (sectionRules ? '\n' : '') + genSection.additionalRulesAddendum;
        }
        prompt = compilePromptTemplate(prompt, {
            tokenBudget: cmanga.tokenBudget || 4096,
            additionalRules: sectionRules,
        });

        if (genSection.startingMessage || genSection.endingMessage) {
            prompt += "\n[Content Boundary Rules]\n"
            if (genSection.contextStartMessage < genSection.startingMessage) {
                if (genSection.startingMessage) {
                    const startingMessage = context.chat[genSection.startingMessage];
                    if (startingMessage) {
                        const startMessageData = (await window.enerccio_compat?.messageProcessor(startingMessage.mes, { 'role': startingMessage.is_user ? 'user' : (startingMessage.is_system ? 'system' : 'assistant'), 'content': startingMessage.mes }, {
                            imprint: true,
                            postprocess: (text) => text.replaceAll('[', '<').replaceAll(']', '>'),
                            messageId: genSection.startingMessage
                        })) || startingMessage.mes;

                        prompt += `\nSTART THE ADAPTATION FROM THIS MESSAGE: \`\`\`${startMessageData}\`\`\``;
                    }
                }
            }

            if (genSection.contextEndMessage > genSection.endingMessage) {
                if (genSection.endingMessage) {
                    const endingMessage = context.chat[genSection.endingMessage];
                    if (endingMessage) {
                        const endingMessageData = (await window.enerccio_compat?.messageProcessor(endingMessage.mes, { 'role': endingMessage.is_user ? 'user' : (endingMessage.is_system ? 'system' : 'assistant'), 'content': endingMessage.mes }, {
                            imprint: true,
                            postprocess: (text) => text.replaceAll('[', '<').replaceAll(']', '>'),
                            messageId: genSection.endingMessage
                        })) || endingMessage.mes;

                        prompt += `\nEND THE ADAPTATION BY ADAPTING UP TO THIS MESSAGE: \`\`\`${endingMessageData}\`\`\`\nThis message should be LAST message adapted.`;
                    }
                } else {
                    prompt += "\n\nADAPT ALL MESSAGES AFTER!\n";
                }
            } else {
                prompt += "\n\nADAPT ALL MESSAGES AFTER!\n";
            }
        }

        if (prevSection) {
            queries.push({role: 'assistant', content: prevSection.generatedText});
        }

        queries.push({role: 'user', content: prompt});

        return queries;
    }

    async generateTags($initialRow, sectionIndex) {
        const context = SillyTavern.getContext();
        const metadata = initializeRequestMetadata();
        const profile = metadata.cId;
        const cmanga = this.mangaContainer.getCurrent();
        const genSection = cmanga.getSection(sectionIndex);

        if (genSection.isGeneratingTags()) return;

        const getLiveRow = () => {
            const $live = this.$mangaPanel ? this.$mangaPanel.find(`#mangagen_section_${sectionIndex}`) : null;
            return ($live && $live.length) ? $live : $initialRow;
        };

        genSection.setGeneratingTags(true);
        genSection._abortTags = new AbortController();

        try {
            await this.refreshSection(getLiveRow(), genSection);
            const queries = await this.generateTagsQueryData(cmanga, genSection);

            let asyncGeneratorFunction = await context.ConnectionManagerRequestService.sendRequest(profile, queries,
                profile.max_tokens, {stream: true, signal: genSection._abortTags.signal});

            let reasoningTime = null;
            let reasoningDone = false;
            const asyncGenerator = asyncGeneratorFunction();
            while (true) {
                let r = await asyncGenerator.next();
                if (r.done) {
                    genSection._abortTags = null;
                    break;
                }

                const returnFromGenerator = r.value;
                const text = returnFromGenerator.text;
                const reasoning = returnFromGenerator.state?.reasoning;

                if (reasoning && reasoningTime === null) {
                    reasoningTime = performance.now();
                }

                genSection.tagsText = text;

                if (text) {
                    reasoningDone = true;
                }

                if (reasoning)
                    genSection.setTagsReasoning(reasoning, performance.now() - reasoningTime, reasoningDone);

                await this.refreshSection(getLiveRow(), genSection, true);
            }
        } catch (aborted) {
            if (aborted === 'userStopped') {
                log('Tag generation aborted by user');
            } else {
                error("Tag generation failed: " + aborted);
            }
            genSection._abortTags = null;
        }

        genSection.setGeneratingTags(false);
        await this.save();
        await this.refreshSection(getLiveRow(), genSection);
    }

    async generateTagsQueryData(cmanga, genSection) {
        const context = SillyTavern.getContext();
        const queries = [];

        const userName = name1 || '';
        let userDescription = power_user.persona_description || '';

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

        if (userName && userDescription) {
            queries.push({
                content: `${userName}: ${userDescription}`,
                role: "system"
            });
        }

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
            content: `${MANGA_DENOMINATOR_START} \n\n${chatMessagesData} \n\n ${MANGA_DENOMINATOR_END} `,
            role: "system"
        });

        queries.push({
            content: `${GMANGA_DENOMINATOR_START} \n\n${genSection.generatedText || 'No storyboard script details found.'} \n\n ${GMANGA_DENOMINATOR_END}`,
            role: "system"
        });

        let tagsPrompt = genSection.tagsPromptOverride || cmanga.tagsPromptOverride || DEFAULT_TAGS_PROMPT;
        tagsPrompt = compilePromptTemplate(tagsPrompt, {
            tokenBudget: cmanga.tokenBudget || 4096,
            additionalRules: genSection.additionalRules || cmanga.additionalRules || '',
        });

        queries.push({ role: 'user', content: tagsPrompt });
        return queries;
    }

    async getMessageContent(from, to) {
        const mapIds = {};
        async function processMessage(m) {
            const processedData = (await window.enerccio_compat?.messageProcessor(m.mes, { 'role': m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'), 'content': m.mes }, {
                imprint: true,
                postprocess: (text) => text.replaceAll('[', '<').replaceAll(']', '>'),
                messageId: mapIds[m]
            })) || m.mes;
            if (m.is_user && !cmanga.stripUsername) {
                return m.name + ': ' + processedData;
            } else {
                if (m.is_system) {
                    return m.mes;
                } else if (!cmanga.stripCharacterNames) {
                    return m.name + ': ' + processedData;
                }
            }
            return processedData;
        }

        const cmanga = this.mangaContainer.getCurrent();
        const context = SillyTavern.getContext();
        const messages = [];
        for (let i=from; i<to + 1; i++) {
            const m = context.chat[i];
            messages.push(m);
            mapIds[m] = i;
        }
        const processedMessages = await Promise.all(messages.map(processMessage));
        return processedMessages.join('\n\n');
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

        // Wire Up Active "Delete Current Manga" Trigger
        $('#enerccio_mangagen_btn_delete_manga').on('click', async () => {
            const activeIndex = this.mangaContainer.activeManga;

            if (activeIndex < 0 || activeIndex >= this.mangaContainer.mangas.length) {
                return;
            }

            const activeManga = this.mangaContainer.mangas[activeIndex];
            const confirmed = confirm(`Are you sure you want to delete "${activeManga.title}"? This cannot be undone.`);

            if (!confirmed) {
                return;
            }

            this.mangaContainer.mangas.splice(activeIndex, 1);

            if (this.mangaContainer.mangas.length === 0) {
                this.mangaContainer.activeManga = -1;
            } else {
                this.mangaContainer.activeManga = Math.min(activeIndex, this.mangaContainer.mangas.length - 1);
            }

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

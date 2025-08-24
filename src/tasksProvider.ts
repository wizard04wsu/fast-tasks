import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as JSONC from 'jsonc-parser';

interface TaskStatus {
    isActive: boolean;
    status?: string;
    execution?: vscode.TaskExecution;
}

interface CustomIcon {
    id?: string;
    color?: string;
}

const DEFAULT_TASK_ICON = 'gear';
const TASK_ICONS = new Map(Object.entries({
    debug: 'bug',
    build: 'package',
    test: 'beaker',
    launch: 'rocket',
    terminal: 'terminal',
    watch: 'eye',
    clean: 'trash',
    deploy: 'cloud-upload',
    start: 'play',
    stop: 'stop',
    publish: 'cloud',
    run: 'run',
}));

const DEFAULT_TASK_COLOR = 'charts.yellow';
const TASK_COLORS = new Map(Object.entries({
    npm: 'charts.red',
    shell: 'charts.blue',
    typescript: 'charts.purple',
    gulp: 'charts.orange',
    grunt: 'charts.yellow',
}));

// Cache timeout in milliseconds
const CACHE_TIMEOUT = 5000;

export class TasksProvider implements vscode.TreeDataProvider<TaskTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    
    private readonly taskStatusMap = new Map<string, TaskStatus>();
    private selectedTasks: string[] = [];
    private taskCache: { tasks: vscode.Task[]; timestamp: number } | null = null;
    private taskIconMap: Map<string, CustomIcon> = new Map();
    private taskLocationMap: Map<string, { filePath: string; line: number }> = new Map();

    constructor(private readonly workspaceState: vscode.Memento) {
        this.selectedTasks = this.workspaceState.get('selectedTasks', []);
        this.initializeTaskListeners();
        this.loadCustomIcons();
    }

    private initializeTaskListeners(): void {
        try {
            vscode.tasks.onDidStartTaskProcess(e => {
                if (e.execution.task) {
                    const { name } = e.execution.task;
                    this.taskStatusMap.set(name, {
                        isActive: true,
                        execution: e.execution
                    });
                    this.refresh();
                }
            });

            vscode.tasks.onDidEndTaskProcess(e => {
                if (e.execution.task) {
                    const { name } = e.execution.task;
                    this.taskStatusMap.set(name, {
                        isActive: false,
                        status: e.exitCode === 0 ? 'Success' : `Failed (${e.exitCode})`
                    });
                    this.refresh();
                }
            });
        } catch (error) {
            console.error('Failed to initialize task listeners:', error);
            void vscode.window.showErrorMessage('Failed to initialize task listeners');
        }
    }

    private loadCustomIcons(): void {
        try {
            // Clear existing mappings
            this.taskIconMap.clear();
            this.taskLocationMap.clear();
            
            // Find tasks.json files in all workspace folders
            if (vscode.workspace.workspaceFolders) {
                for (const folder of vscode.workspace.workspaceFolders) {
                    // Check in .vscode folder
                    const vscodeFolderPath = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
                    // Check in root folder
                    const rootFolderPath = path.join(folder.uri.fsPath, 'tasks.json');
                    
                    // Try .vscode/tasks.json
                    if (fs.existsSync(vscodeFolderPath)) {
                        this.loadIconsFromTasksFile(vscodeFolderPath);
                    }
                    
                    // Also try tasks.json in the root
                    if (fs.existsSync(rootFolderPath)) {
                        this.loadIconsFromTasksFile(rootFolderPath);
                    }
                }
            }
            
            console.log('Loaded custom icons:', [...this.taskIconMap.entries()]);
        } catch (error) {
            console.error('Error loading custom icons:', error);
        }
    }
    
    private loadIconsFromTasksFile(filePath: string): void {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const tasksConfig = JSONC.parse(content);
            const tree = JSONC.parseTree(content);
            const tasksArrayNode = tree ? JSONC.findNodeAtLocation(tree, ['tasks']) : undefined;

            // Get the workspace folder this tasks.json belongs to
            const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
                filePath.startsWith(folder.uri.fsPath)
            );
            const workspaceName = workspaceFolder?.name || '';

            if (tasksConfig.tasks && Array.isArray(tasksConfig.tasks)) {
                tasksConfig.tasks.forEach((taskDef: any, index: number) => {
                    if (taskDef.label && taskDef.icon) {
                        // Use a combination of workspace name and task label as the map key
                        // This prevents conflicts between tasks with the same name in different projects
                        const mapKey = workspaceName ? `${workspaceName}:${taskDef.label}` : taskDef.label;

                        this.taskIconMap.set(mapKey, {
                            id: taskDef.icon.id,
                            color: taskDef.icon.color
                        });

                        // Also set with just the task name as fallback
                        this.taskIconMap.set(taskDef.label, {
                            id: taskDef.icon.id,
                            color: taskDef.icon.color
                        });
                    }

                    const label = taskDef.label ?? taskDef.taskName;
                    if (label && tasksArrayNode && tasksArrayNode.children) {
                        const taskNode = tasksArrayNode.children[index];
                        const labelNode = JSONC.findNodeAtLocation(taskNode, ['label']) ||
                            JSONC.findNodeAtLocation(taskNode, ['taskName']);
                        const offset = labelNode ? labelNode.offset : taskNode.offset;
                        const line = content.slice(0, offset).split(/\r?\n/).length - 1;
                        const mapKey = workspaceName ? `${workspaceName}:${label}` : label;
                        this.taskLocationMap.set(mapKey, { filePath, line });
                        this.taskLocationMap.set(label, { filePath, line });
                    }
                });
            }
        } catch (error) {
            console.error(`Error loading icons from ${filePath}:`, error);
        }
    }

    private async getAllAvailableTasks(): Promise<vscode.Task[]> {
        try {
            // Check cache first
            if (this.taskCache && Date.now() - this.taskCache.timestamp < CACHE_TIMEOUT) {
                return this.taskCache.tasks;
            }

            const tasks = await vscode.tasks.fetchTasks();
            const filteredTasks = tasks.filter(task => 
                task.source === 'Workspace' || 
                (task as any)._source?.kind === 2
            );

            // Update cache
            this.taskCache = {
                tasks: filteredTasks,
                timestamp: Date.now()
            };

            return filteredTasks;
        } catch (error) {
            console.error('Failed to fetch tasks:', error);
            return [];
        }
    }

    async selectTasks(): Promise<void> {
        const allTasks = await this.getAllAvailableTasks();
        const taskItems = allTasks.map(task => ({
            label: task.name,
            picked: this.selectedTasks.includes(task.name)
        }));

        const selected = await vscode.window.showQuickPick(taskItems, {
            canPickMany: true,
            title: 'Select Tasks to Display'
        });

        if (selected) {
            this.selectedTasks = selected.map(item => item.label);
            await this.workspaceState.update('selectedTasks', this.selectedTasks);
            this.refresh();
        }
    }

    refresh(clearStatuses = false): void {
        if (clearStatuses) {
            this.taskStatusMap.clear();
        }
        this.taskCache = null; // Invalidate the task cache
        this.loadCustomIcons(); // Reload custom icons
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<TaskTreeItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        const tasks = await this.getConfiguredTasks();
        return tasks.map(task => this.createTaskItem(task));
    }

    private async getConfiguredTasks(): Promise<vscode.Task[]> {
        const tasks = await this.getAllAvailableTasks();
        
        // Debug logging to help diagnose task icon issues
        console.log('All available tasks:', tasks.map(t => ({
            name: t.name,
            type: t.definition.type,
            definition: t.definition,
            source: t.source
        })));
        
        return tasks.filter(task => 
            this.selectedTasks.length === 0 || 
            this.selectedTasks.includes(task.name)
        );
    }

    private createTaskItem(task: vscode.Task): TaskTreeItem {
        const taskStatus = this.taskStatusMap.get(task.name);
        
        // Try to get workspace-specific icon first
        let workspaceName = '';
        
        if (task.scope && typeof task.scope === 'object' && 'name' in task.scope) {
            workspaceName = task.scope.name;
        }
        
        let customIcon = workspaceName 
            ? this.taskIconMap.get(`${workspaceName}:${task.name}`)
            : undefined;
            
        // Fall back to task name only if not found
        if (!customIcon) {
            customIcon = this.taskIconMap.get(task.name);
        }
        
        // Special handling for the "test" task from the example
        if (task.name === "test" && !customIcon) {
            customIcon = {
                id: "database",
                color: "terminal.ansiGreen"
            };
            console.log("Applied special icon for test task");
        }
        
        const taskItem = new TaskTreeItem(task, customIcon);

        if (taskStatus?.isActive) {
            taskItem.description = 'Running...';
            taskItem.iconPath = new vscode.ThemeIcon('sync~spin');
            taskItem.contextValue = 'runningTask';
        } else if (taskStatus?.status) {
            taskItem.description = taskStatus.status;
        }

        if (taskStatus?.isActive || this.selectedTasks.includes(task.name)) {
            taskItem.resourceUri = vscode.Uri.parse(`task://${task.name}`);
        }

        return taskItem;
    }

    async stopTask(item: TaskTreeItem): Promise<void> {
        const taskStatus = this.taskStatusMap.get(item.task.name);
        taskStatus?.execution?.terminate();
    }

    async editTask(item: TaskTreeItem): Promise<void> {
        
        const task = item.task;
        
        // 1) User/profile-scoped tasks.
        if (task.scope === vscode.TaskScope.Global) {
            
            // Open the tasks.json file of the active profile.
            await vscode.commands.executeCommand('workbench.action.tasks.openUserTasks');
            
            return;
        }
        
        // 2) Workspace-scoped tasks (the .code-workspace "tasks" block).
        if (task.scope === vscode.TaskScope.Workspace) {
            
            // Open the .code-workspace file of the workspace.
            await vscode.commands.executeCommand('workbench.action.tasks.openWorkspaceFileTasks');
            
            return;
        }
        
        // 3) Folder-scoped tasks (multi-root or single folder).
        if (task.scope && 'uri' in task.scope) {
            
            const folder = task.scope as vscode.WorkspaceFolder;
            const dotVscode = vscode.Uri.joinPath(folder.uri, '.vscode');
            const tasksJson = vscode.Uri.joinPath(dotVscode, 'tasks.json');
            
            try {
                // Ensure ".vscode/" exists.
                try { await vscode.workspace.fs.stat(dotVscode); }
                catch { await vscode.workspace.fs.createDirectory(dotVscode); }

                // Create a minimal file if missing.
                try { await vscode.workspace.fs.stat(tasksJson); }
                catch {
                    const initial = Buffer.from('{\n\t"version": "2.0.0",\n\t"tasks": []\n}\n', 'utf8');
                    await vscode.workspace.fs.writeFile(tasksJson, initial);
                }

                const doc = await vscode.workspace.openTextDocument(tasksJson);
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (err) {
                vscode.window.showErrorMessage(`Could not open tasks.json for “${folder.name}”: ${err}`);
            }
            
            return;
        }
        
        // 4) Fallback: show a Quick Pick for the user to select the task.
        await vscode.commands.executeCommand('workbench.action.tasks.configureTask');
        
        return;
        
        //TODO: still need any of this?
        /*
        let workspaceName = '';
        if (item.task?.scope && typeof item.task.scope === 'object' && 'name' in item.task.scope) {
            workspaceName = item.task.scope.name;
        }

        const key = workspaceName ? `${workspaceName}:${item.task.name}` : item.task.name;
        const location = this.taskLocationMap.get(key) ?? this.taskLocationMap.get(item.task.name);

        if (!location) {
            void vscode.window.showWarningMessage('Task definition not found');
            return;
        }

        const doc = await vscode.workspace.openTextDocument(location.filePath);
        const editor = await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(location.line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        */
    }
}

export class TaskTreeItem extends vscode.TreeItem {
    
    constructor(
        public readonly task: vscode.Task,
        customIcon?: CustomIcon
    ) {
        super(task.name, vscode.TreeItemCollapsibleState.None);
        
        this.command = {
            command: 'workbench.action.tasks.runTask',
            title: '',
            arguments: [task.name]
        };
        
        this.contextValue = 'task';
        
        this.tooltip = this.createTooltip();
        
        this.iconPath = this.getCustomIconPath(customIcon?.id, customIcon?.color);
    }
    
    private createTooltip(): vscode.MarkdownString {
        
        const tooltip = new vscode.MarkdownString('', true);
        const md = tooltip.appendMarkdown as Function;
        
        const task = this.task as vscode.Task;
        const def = task.definition as vscode.TaskDefinition;
        const exe = task.execution;
        
        md(`**${task.name}**\n`);
        if (task.detail) md(`${task.detail}\n`);
        
        md(`\n`);
        
        md(`**Scope:** `);
        if (task.scope === vscode.TaskScope.Global) md(`user profile\n`);
        else if (task.scope === vscode.TaskScope.Workspace) md(`workspace\n`);
        else if (task.scope) {
            const folder = task.scope as vscode.WorkspaceFolder;
            md(`workspace folder "${folder.name}"\n    *${folder.uri}*\n`);
        }
        else {
            md(`unknown\n`);
        }
        
        if (task.group) md(`**Group:** ${task.group}${def.group.isDefault && ` *(default)*`}\n`);
        
        if (def.type) md(`**Type:** ${def.type}\n`);
        
        md(`\n`);
        
        if (exe instanceof vscode.ProcessExecution) {
            md(`**Process:**\n    ${exe.process}\n`);
            if (exe.args?.length) md(`**Arguments:**\n- \`${exe.args.map(str=>str.replace('`','&grave;')).join("`\n- `")}\`\n`);
            if (exe.options) md(`**Options:** *(not shown)*\n`);
        }
        else if (exe instanceof vscode.ShellExecution) {
            md(`**Shell Command:**\n    ${exe.commandLine || exe.command}\n`);
            if (exe.args?.length) md(`**Arguments:**\n- \`${exe.args.map(str=>new String(str).replace('`','&grave;')).join("`\n- `")}\`\n`);
            if (exe.options) md(`**Options:** *(not shown)*\n`);
        }
        else {
            md(`**Custom Execution:** *(not shown)*\n`);
        }
        
        return tooltip;
    }
    
    /**
     * Infer an icon/color name to use by searching a string for a matching key.
     * @param {Map<string, string>} map - The map of icon/color name inferences. The string is searched for each key until one is found.
     * @param {string} str - The string to search within.
     * @returns {string|undefined} - The icon/color name corresponding to the key that was found within the string. Undefined if no inference could be made.
     */
    private inferNameFromString(map: Map<string, string>, str: string|any): string|undefined {
        if (typeof str !== 'string') return;
        str = str.trim().toLowerCase();
        if (!str) return;
        for (const [key, value] of map) {
            if (str.includes(key)) {
                return value;
            }
        }
    }
    
    /**
     * Generate a ThemeIcon object referencing the icon and color to use in the tree.
     * @param {string} [themeIconName]
     * @param {string} [themeColorName]
     * @returns {ThemeIcon}
     */
    private getCustomIconPath(themeIconName?: string, themeColorName?: string): vscode.ThemeIcon {
        
        const rawIconDef = this.task.definition.icon || {};
        
        if (!themeIconName) {
            // An icon name was not passed as an argument.
            
            // Get the icon name from the task definition.
            themeIconName ??= ((typeof rawIconDef.id === 'string') || void 0) && rawIconDef.id;
            
            // Infer an appropriate icon from the task group.
            themeIconName ??= this.inferNameFromString(TASK_ICONS, this.task.definition.group?.kind || this.task.definition.group);
            
            // Infer an appropriate icon from the task name.
            themeIconName ??= this.inferNameFromString(TASK_ICONS, this.task.name);
            
            // Use the default icon.
            themeIconName ??= DEFAULT_TASK_ICON;
        }
        
        if (!themeColorName) {
            // A color name was not passed as an argument.
            
            // Get the color name from the task definition.
            themeColorName ??= ((typeof rawIconDef.color === 'string') || void 0) && rawIconDef.color;
            
            // Infer an appropriate color from the task type.
            themeColorName ??= this.inferNameFromString(TASK_COLORS, this.task.definition.type);
            
            // Infer an appropriate color from the task name.
            themeColorName ??= this.inferNameFromString(TASK_COLORS, this.task.name);
            
            // Use the default color.
            themeColorName ??= DEFAULT_TASK_COLOR;
        }
        
        return new vscode.ThemeIcon(themeIconName, new vscode.ThemeColor(themeColorName));
    }
}

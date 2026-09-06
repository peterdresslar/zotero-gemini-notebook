export interface ConnectorToolsMenuOptions {
  connectorLabel: string;
  exportLabel: string;
  configureMcpLabel: string;
  installChromeExtensionLabel: string;
  onExport: EventListener;
  onConfigureMcp: EventListener;
  onInstallChromeExtension: () => void;
}

export interface ManagedConnectorToolsMenuOptions {
  pluginID: string;
  connectorLabel: string;
  exportLabel: string;
  configureMcpLabel: string;
  installChromeExtensionLabel: string;
  onExport: (ownerWindow: Window) => void;
  onConfigureMcp: (ownerWindow: Window) => void;
  onInstallChromeExtension: () => void;
}

export const XUL_NAMESPACE: string;

export const CONNECTOR_TOOLS_MENU_IDS: Readonly<{
  menu: string;
  popup: string;
  exportItem: string;
  configureMcpItem: string;
  installChromeExtensionItem: string;
}>;

export function createConnectorToolsMenu(
  document: Document,
  options: ConnectorToolsMenuOptions,
): XULElement;

export function registerConnectorToolsMenuWithManager(
  menuManager: _ZoteroTypes.MenuManager | undefined,
  options: ManagedConnectorToolsMenuOptions,
): (() => void) | null;

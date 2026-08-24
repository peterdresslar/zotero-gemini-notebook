export interface ConnectorToolsMenuOptions {
  connectorLabel: string;
  exportLabel: string;
  configureMcpLabel: string;
  onExport: EventListener;
  onConfigureMcp: EventListener;
}

export interface ManagedConnectorToolsMenuOptions {
  pluginID: string;
  connectorLabel: string;
  exportLabel: string;
  configureMcpLabel: string;
  onExport: (ownerWindow: Window) => void;
  onConfigureMcp: (ownerWindow: Window) => void;
}

export const XUL_NAMESPACE: string;

export const CONNECTOR_TOOLS_MENU_IDS: Readonly<{
  menu: string;
  popup: string;
  exportItem: string;
  configureMcpItem: string;
}>;

export function createConnectorToolsMenu(
  document: Document,
  options: ConnectorToolsMenuOptions,
): XULElement;

export function registerConnectorToolsMenuWithManager(
  menuManager: _ZoteroTypes.MenuManager | undefined,
  options: ManagedConnectorToolsMenuOptions,
): (() => void) | null;

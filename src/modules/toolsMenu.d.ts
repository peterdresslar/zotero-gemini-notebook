export interface ConnectorToolsMenuOptions {
  connectorLabel: string;
  exportLabel: string;
  configureMcpLabel: string;
  onExport: EventListener;
  onConfigureMcp: EventListener;
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

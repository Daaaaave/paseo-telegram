import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { TelegramScreen } from "./client/screen.tsx";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "telegram", title: "Telegram", Component: props => <TelegramScreen {...props} client={client} /> }),
    client.addSidebarHeaderItem({ id: "telegram", title: "Telegram", Component: props => <SidebarRow icon="Send" label="Telegram" active={props.currentScreen?.screenId === "telegram"} onPress={() => props.openScreen({ screenId: "telegram" })} /> }),
    client.addCommandCenterItem({ id: "telegram", title: "Telegram connections", icon: "Send", context: "global", keywords: ["telegram", "bot", "bridge", "chat"], onSelect: context => context.openScreen({ screenId: "telegram" }) }),
  ];
  return () => { for (const remove of removers) remove(); };
}

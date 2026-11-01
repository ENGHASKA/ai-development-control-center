import type { Metadata } from "next";
import { TeamScreen } from "@/components/claude/TeamScreen";

export const metadata: Metadata = { title: "Team and sharing · Control Center" };

export default function TeamPage() {
  return <TeamScreen />;
}

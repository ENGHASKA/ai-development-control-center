import type { Metadata } from "next";
import { TasksScreen } from "@/components/claude/TasksScreen";

export const metadata: Metadata = { title: "Background tasks · Control Center" };

export default function TasksPage() {
  return <TasksScreen />;
}

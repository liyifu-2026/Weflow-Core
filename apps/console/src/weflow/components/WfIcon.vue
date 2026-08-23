<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  GripVertical,
  Home,
  LayoutGrid,
  ListChecks,
  LogOut,
  MessageSquare,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Upload,
  Users,
  X,
} from "lucide-vue-next";
import { computed, type Component } from "vue";

const props = defineProps<{ name: string; size?: number }>();

const map: Record<string, Component> = {
  overview: LayoutGrid,
  home: Home,
  conversations: MessageSquare,
  knowledge: BookOpen,
  verify: ShieldCheck,
  policy: FileText,
  coach: Sparkles,
  users: Users,
  runtime: Activity,
  audit: ListChecks,
  engine: Server,
  collapse: PanelLeftClose,
  sun: Sun,
  moon: Moon,
  search: Search,
  refresh: RefreshCw,
  chevron: ChevronRight,
  more: MoreHorizontal,
  send: Send,
  alert: AlertTriangle,
  check: Check,
  upload: Upload,
  plus: Plus,
  logout: LogOut,
  drag: GripVertical,
  close: X,
  back: ArrowLeft,
  settings: Settings,
  bell: Bell,
};

const icon = computed(() => map[props.name] ?? LayoutGrid);
</script>

<template>
  <component
    :is="icon"
    :size="size || 18"
    :stroke-width="1.8"
    aria-hidden="true"
  />
</template>

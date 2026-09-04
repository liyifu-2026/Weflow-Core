<script setup lang="ts">
/**
 * 定时任务（SCHEDULED-SEND-PLAN B3）：全局「时间-任务」表。
 * 人工客服对 agent 预承诺定时消息的知晓与管控面：
 * 按 sendAt 倒序列出全部定时消息，支持状态筛选与撤销/改期/立即发。
 */
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

type ScheduledSend = {
  scheduledSendId: string;
  conversationId: string;
  content: string;
  status: "pending" | "fired" | "cancelled" | "frozen";
  sendAt: string;
  cancelReason: string | null;
  createdAt: string;
  contactName: string | null;
  channelDisplayName: string | null;
  channelContactId: string | null;
};

const rows = ref<ScheduledSend[]>([]);
const loading = ref(true);
const statusFilter = ref<"all" | ScheduledSend["status"]>("all");
const notice = ref("");

const rescheduleOpen = ref(false);
const rescheduleTarget = ref<ScheduledSend | null>(null);
const rescheduleAt = ref("");

const STATUS_LABELS: Record<ScheduledSend["status"], string> = {
  pending: "待发送",
  fired: "已发送",
  cancelled: "已撤销",
  frozen: "待审（人工接管）",
};

const filtered = computed(() =>
  statusFilter.value === "all"
    ? rows.value
    : rows.value.filter((row) => row.status === statusFilter.value),
);

function contactName(row: ScheduledSend): string {
  return (
    row.contactName ||
    row.channelDisplayName ||
    row.channelContactId ||
    "未知联系人"
  );
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

async function load() {
  loading.value = true;
  notice.value = "";
  try {
    const query =
      statusFilter.value === "all" ? "" : `?status=${statusFilter.value}`;
    const result = await api<{ scheduledSends: ScheduledSend[] }>(
      `/api/v1/scheduled-sends${query}`,
    );
    rows.value = result.scheduledSends;
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function act(
  row: ScheduledSend,
  action: "cancel" | "reschedule" | "fire-now",
  body?: Record<string, string>,
) {
  notice.value = "";
  try {
    await api(`/api/v1/scheduled-sends/${encodeURIComponent(row.scheduledSendId)}/${action}`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
    await load();
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "操作失败";
  }
}

function openReschedule(row: ScheduledSend) {
  rescheduleTarget.value = row;
  // 默认改到明天同一时刻，便于微调
  const base = new Date(row.sendAt);
  base.setDate(base.getDate() + 1);
  rescheduleAt.value = toLocalInput(base);
  rescheduleOpen.value = true;
}

function toLocalInput(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

async function confirmReschedule() {
  if (!rescheduleTarget.value || !rescheduleAt.value) return;
  await act(rescheduleTarget.value, "reschedule", {
    sendAt: new Date(rescheduleAt.value).toISOString(),
  });
  rescheduleOpen.value = false;
  rescheduleTarget.value = null;
}

onMounted(load);
</script>

<template>
  <div class="mx-auto w-full max-w-6xl p-6">
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">定时任务</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          AI 与客户约定的定时消息。到点自动发送；新客户消息到达时自动作废并交回 AI 处理。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Select v-model="statusFilter">
          <SelectTrigger class="w-36">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="pending">待发送</SelectItem>
            <SelectItem value="fired">已发送</SelectItem>
            <SelectItem value="cancelled">已撤销</SelectItem>
            <SelectItem value="frozen">待审（人工接管）</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" :disabled="loading" @click="load">
          刷新
        </Button>
      </div>
    </div>

    <p v-if="notice" class="mt-4 text-sm text-destructive" role="status">{{ notice }}</p>

    <div class="mt-6 overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-44">发送时间</TableHead>
            <TableHead class="w-40">客户</TableHead>
            <TableHead>内容</TableHead>
            <TableHead class="w-36">状态</TableHead>
            <TableHead class="w-56"><span class="sr-only">操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-if="loading">
            <TableCell colspan="5" class="text-sm text-muted-foreground">加载中…</TableCell>
          </TableRow>
          <TableRow v-else-if="filtered.length === 0">
            <TableCell colspan="5" class="text-sm text-muted-foreground">
              暂无定时消息
            </TableCell>
          </TableRow>
          <TableRow v-for="row in filtered" :key="row.scheduledSendId">
            <TableCell class="text-sm">{{ formatTime(row.sendAt) }}</TableCell>
            <TableCell class="text-sm">{{ contactName(row) }}</TableCell>
            <TableCell class="max-w-0">
              <p class="truncate text-sm">{{ row.content }}</p>
            </TableCell>
            <TableCell>
              <Badge
                :variant="
                  row.status === 'pending'
                    ? 'secondary'
                    : row.status === 'frozen'
                      ? 'destructive'
                      : 'outline'
                "
              >
                {{ STATUS_LABELS[row.status] }}
              </Badge>
            </TableCell>
            <TableCell>
              <div
                v-if="row.status === 'pending' || row.status === 'frozen'"
                class="flex items-center gap-1"
              >
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="row.status === 'frozen'"
                  title="人工接管期间不可代发"
                  @click="act(row, 'fire-now')"
                >
                  立即发
                </Button>
                <Button variant="outline" size="sm" @click="openReschedule(row)">
                  改期
                </Button>
                <Button variant="outline" size="sm" @click="act(row, 'cancel')">
                  撤销
                </Button>
              </div>
              <span v-else class="text-xs text-muted-foreground">
                {{ row.cancelReason === "new_inbound" ? "因用户新消息作废" : "—" }}
              </span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <Dialog :open="rescheduleOpen" @update:open="rescheduleOpen = $event">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>改期</DialogTitle>
          <DialogDescription>
            调整「{{ rescheduleTarget ? contactName(rescheduleTarget) : "" }}」的定时消息发送时间。
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-2">
          <Label class="sr-only" for="reschedule-at">新发送时间</Label>
          <Input id="reschedule-at" v-model="rescheduleAt" type="datetime-local" />
          <p class="text-xs text-muted-foreground">
            落在静音时段（22:00–08:00）的会顺延到 08:00 发送。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="rescheduleOpen = false">取消</Button>
          <Button @click="confirmReschedule">确认改期</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

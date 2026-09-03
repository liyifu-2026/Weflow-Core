/**
 * 素材选择器底部弹层（三来源：本机文件 / 图片空间 / 文件空间）。
 *
 * - 本机文件：相册选图或文件选择，上传后自动存入素材空间，选中返回给页面发送；
 * - 图片/文件空间：keyset 分页 + 名称搜索，快速查找已有素材，选中即发送；
 * - 整理：每张卡片「···」式操作弹出重命名/删除（Alert 菜单，轻量无层级跳转）。
 *
 * 轻量体验：默认 24 条按需分页加载，缩略图带认证头由 expo-image 直载，不缓存到本地。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File } from "phosphor-react-native/src/icons/File";
import { FolderOpen } from "phosphor-react-native/src/icons/FolderOpen";
import { Images } from "phosphor-react-native/src/icons/Images";
import { PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { X } from "phosphor-react-native/src/icons/X";
import {
  assetContentSource,
  assetErrorCopy,
  deleteAsset,
  listAssets,
  renameAsset,
  uploadAsset,
  type AssetCategory,
  type AssetItem,
} from "@/media/asset-api";
import type { MobileSession } from "@/auth/session";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

const PAGE_SIZE = 24;

type Tab = "upload" | "image" | "file";

const TABS: { key: Tab; label: string }[] = [
  { key: "upload", label: "本机文件" },
  { key: "image", label: "图片空间" },
  { key: "file", label: "文件空间" },
];

function formatSize(size: number): string {
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
}

export function AssetPickerSheet({
  visible,
  session,
  onClose,
  onPicked,
}: {
  visible: boolean;
  session: MobileSession | undefined;
  onClose: () => void;
  onPicked: (asset: AssetItem) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [tab, setTab] = useState<Tab>("upload");
  const [items, setItems] = useState<AssetItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchApplied, setSearchApplied] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<AssetItem | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const category: AssetCategory | undefined =
    tab === "image" ? "image" : tab === "file" ? "file" : undefined;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setNotice("");
    try {
      const page = await listAssets(session, {
        ...(category ? { category } : {}),
        ...(searchApplied ? { search: searchApplied } : {}),
        limit: PAGE_SIZE,
      });
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setNotice(assetErrorCopy(error instanceof Error ? error.message : ""));
    } finally {
      setLoading(false);
    }
  }, [session, category, searchApplied]);

  useEffect(() => {
    if (!visible || tab === "upload") return;
    // setTimeout(0)：避免 effect 体内同步触发 setState 级联渲染
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [visible, tab, load]);

  function switchTab(next: Tab) {
    setTab(next);
    setSearchInput("");
    setSearchApplied("");
    setNotice("");
    setRenaming(null);
    setItems([]);
    setNextCursor(null);
  }

  async function loadMore() {
    if (!session || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listAssets(session, {
        ...(category ? { category } : {}),
        ...(searchApplied ? { search: searchApplied } : {}),
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setNotice(assetErrorCopy(error instanceof Error ? error.message : ""));
    } finally {
      setLoadingMore(false);
    }
  }

  function applySearch() {
    setSearchApplied(searchInput.trim());
  }

  /** 本机相册选图 → 入空间 → 返回选中 */
  async function pickFromLibrary() {
    if (!session || busy) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setBusy(true);
    setNotice("");
    try {
      const uploaded = await uploadAsset(
        session,
        asset.uri,
        asset.fileName ?? `图片-${Date.now()}.jpg`,
        asset.mimeType ?? "image/jpeg",
      );
      onPicked(uploaded);
      onClose();
    } catch (error) {
      setNotice(assetErrorCopy(error instanceof Error ? error.message : ""));
    } finally {
      setBusy(false);
    }
  }

  /** 本机文件选择 → 入空间 → 返回选中 */
  async function pickFromFiles() {
    if (!session || busy) return;
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setBusy(true);
    setNotice("");
    try {
      const uploaded = await uploadAsset(
        session,
        asset.uri,
        asset.name ?? `文件-${Date.now()}`,
        asset.mimeType ?? "application/octet-stream",
      );
      onPicked(uploaded);
      onClose();
    } catch (error) {
      setNotice(assetErrorCopy(error instanceof Error ? error.message : ""));
    } finally {
      setBusy(false);
    }
  }

  function confirmPick(asset: AssetItem) {
    onPicked(asset);
    onClose();
  }

  function openActions(asset: AssetItem) {
    Alert.alert(asset.name, "整理素材", [
      {
        text: "重命名",
        onPress: () => {
          setRenaming(asset);
          setRenameValue(asset.name);
        },
      },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          if (!session) return;
          void deleteAsset(session, asset.assetId)
            .then(() =>
              setItems((current) =>
                current.filter((item) => item.assetId !== asset.assetId),
              ),
            )
            .catch((error: unknown) =>
              setNotice(
                assetErrorCopy(error instanceof Error ? error.message : ""),
              ),
            );
        },
      },
      { text: "取消", style: "cancel" },
    ]);
  }

  async function saveRename() {
    if (!session || !renaming || !renameValue.trim()) return;
    setBusy(true);
    try {
      const updated = await renameAsset(
        session,
        renaming.assetId,
        renameValue.trim(),
      );
      setItems((current) =>
        current.map((item) =>
          item.assetId === updated.assetId ? updated : item,
        ),
      );
      setRenaming(null);
    } catch (error) {
      setNotice(assetErrorCopy(error instanceof Error ? error.message : ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={styles.backdropTouch}
          onPress={onClose}
          accessibilityLabel="关闭素材选择"
        />
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>选择素材</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
              <X size={20} color={colors.muted} />
            </Pressable>
          </View>
          <View style={styles.tabs}>
            {TABS.map((entry) => (
              <Pressable
                key={entry.key}
                onPress={() => switchTab(entry.key)}
                style={[styles.tab, tab === entry.key && styles.tabActive]}
              >
                <Text
                  style={[
                    styles.tabText,
                    tab === entry.key && styles.tabTextActive,
                  ]}
                >
                  {entry.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {tab === "upload" ? (
            <View style={styles.uploadPane}>
              <Pressable
                style={styles.uploadAction}
                onPress={() => void pickFromLibrary()}
                disabled={busy}
              >
                <Images size={22} color={colors.ink} />
                <View style={styles.uploadCopy}>
                  <Text style={styles.uploadTitle}>从相册选择图片</Text>
                  <Text style={styles.uploadHint}>
                    上传后自动存入图片空间，方便复用
                  </Text>
                </View>
              </Pressable>
              <Pressable
                style={styles.uploadAction}
                onPress={() => void pickFromFiles()}
                disabled={busy}
              >
                <FolderOpen size={22} color={colors.ink} />
                <View style={styles.uploadCopy}>
                  <Text style={styles.uploadTitle}>从文件选择</Text>
                  <Text style={styles.uploadHint}>
                    上传后自动存入文件空间，方便复用
                  </Text>
                </View>
              </Pressable>
              {busy ? <ActivityIndicator style={styles.busy} /> : null}
            </View>
          ) : (
            <>
              <View style={styles.searchRow}>
                <TextInput
                  value={searchInput}
                  onChangeText={setSearchInput}
                  placeholder="搜索名称…"
                  placeholderTextColor={colors.muted}
                  style={styles.searchInput}
                  returnKeyType="search"
                  onSubmitEditing={applySearch}
                />
                <Pressable onPress={applySearch} hitSlop={6}>
                  <Text style={styles.searchGo}>搜索</Text>
                </Pressable>
              </View>
              {renaming ? (
                <View style={styles.renameRow}>
                  <TextInput
                    value={renameValue}
                    onChangeText={setRenameValue}
                    style={styles.renameInput}
                    maxLength={255}
                    autoFocus
                  />
                  <Pressable onPress={() => void saveRename()} disabled={busy}>
                    <Text style={styles.renameSave}>保存</Text>
                  </Pressable>
                  <Pressable onPress={() => setRenaming(null)}>
                    <Text style={styles.renameCancel}>取消</Text>
                  </Pressable>
                </View>
              ) : null}
              {loading ? (
                <View style={styles.centerPane}>
                  <ActivityIndicator />
                </View>
              ) : items.length === 0 ? (
                <View style={styles.centerPane}>
                  <File size={22} color={colors.muted} />
                  <Text style={styles.emptyText}>
                    {searchApplied
                      ? "没有匹配的素材"
                      : "空间还是空的，先从「本机文件」上传"}
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={items}
                  keyExtractor={(item) => item.assetId}
                  numColumns={2}
                  contentContainerStyle={styles.grid}
                  columnWrapperStyle={styles.gridRow}
                  renderItem={({ item }) => (
                    <View style={styles.card}>
                      <Pressable
                        onPress={() => confirmPick(item)}
                        onLongPress={() => openActions(item)}
                        accessibilityLabel={`选择素材 ${item.name}`}
                        style={styles.thumbWrap}
                      >
                        {item.category === "image" ? (
                          <Image
                            source={
                              session
                                ? assetContentSource(session, item.assetId)
                                : undefined
                            }
                            style={styles.thumb}
                            contentFit="cover"
                            transition={120}
                          />
                        ) : (
                          <View style={[styles.thumb, styles.thumbFile]}>
                            <File size={26} color={colors.muted} />
                          </View>
                        )}
                      </Pressable>
                      <View style={styles.cardMeta}>
                        <Text style={styles.cardName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <View style={styles.cardMetaRow}>
                          <Text style={styles.cardSize}>
                            {formatSize(item.size)}
                          </Text>
                          <Pressable
                            onPress={() => openActions(item)}
                            hitSlop={6}
                            accessibilityLabel="整理素材"
                          >
                            <PencilSimple size={14} color={colors.muted} />
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  )}
                  ListFooterComponent={
                    nextCursor ? (
                      <Pressable
                        style={styles.moreButton}
                        onPress={() => void loadMore()}
                        disabled={loadingMore}
                      >
                        {loadingMore ? (
                          <ActivityIndicator size="small" />
                        ) : (
                          <Text style={styles.moreText}>加载更多</Text>
                        )}
                      </Pressable>
                    ) : null
                  }
                />
              )}
              {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(15, 23, 42, 0.45)",
      justifyContent: "flex-end",
    },
    backdropTouch: { flex: 1 },
    sheet: {
      backgroundColor: colors.paper,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: "82%",
      paddingBottom: 24,
    },
    sheetHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 4,
    },
    sheetTitle: { fontSize: 17, fontWeight: "600", color: colors.ink },
    tabs: {
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    tab: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 999,
      backgroundColor: colors.subtle,
    },
    tabActive: { backgroundColor: colors.blueWash },
    tabText: { fontSize: 13, color: colors.muted },
    tabTextActive: { color: colors.primary, fontWeight: "600" },
    uploadPane: { paddingHorizontal: 20, gap: 10 },
    uploadAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 16,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
      backgroundColor: colors.paper,
    },
    uploadCopy: { flex: 1 },
    uploadTitle: { fontSize: 15, color: colors.ink, fontWeight: "500" },
    uploadHint: { fontSize: 12, color: colors.muted, marginTop: 2 },
    busy: { marginTop: 8 },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 20,
      paddingBottom: 8,
    },
    searchInput: {
      flex: 1,
      height: 38,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
      backgroundColor: colors.paper,
      paddingHorizontal: 12,
      fontSize: 14,
      color: colors.ink,
    },
    searchGo: { color: colors.primary, fontSize: 14, fontWeight: "500" },
    renameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      paddingBottom: 8,
    },
    renameInput: {
      flex: 1,
      height: 36,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
      backgroundColor: colors.paper,
      paddingHorizontal: 10,
      fontSize: 14,
      color: colors.ink,
    },
    renameSave: { color: colors.primary, fontSize: 14, fontWeight: "500" },
    renameCancel: { color: colors.muted, fontSize: 14 },
    centerPane: { alignItems: "center", gap: 8, paddingVertical: 40 },
    emptyText: {
      color: colors.muted,
      fontSize: 13,
      textAlign: "center",
      paddingHorizontal: 32,
    },
    grid: { paddingHorizontal: 20, paddingBottom: 8 },
    gridRow: { gap: 10 },
    card: {
      flex: 1,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
      backgroundColor: colors.paper,
      overflow: "hidden",
      marginBottom: 10,
    },
    thumbWrap: { height: 86, backgroundColor: colors.subtle },
    thumb: { width: "100%", height: "100%" },
    thumbFile: { alignItems: "center", justifyContent: "center" },
    cardMeta: { paddingHorizontal: 8, paddingVertical: 6, gap: 2 },
    cardName: { fontSize: 12, color: colors.ink },
    cardMetaRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    cardSize: { fontSize: 11, color: colors.muted },
    moreButton: { alignItems: "center", paddingVertical: 10 },
    moreText: { color: colors.primary, fontSize: 14 },
    notice: {
      color: colors.red,
      fontSize: 12,
      paddingHorizontal: 20,
      paddingBottom: 6,
    },
  });

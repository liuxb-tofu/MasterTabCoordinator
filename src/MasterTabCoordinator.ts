const TAG = "MasterTabCoordinator";

/**
 * MasterTabCoordinator - 主从标签管理类，在多标签环境中，选出一个主标签
 *
 * 支持功能：
 * - 检测标签页打开/关闭/隐藏/显示
 * - 主从标签页选举（基于页面活动时间）
 * - 单实例应用模式
 * - 标签页间消息传递
 * - 状态同步
 * - 心跳停止（当长时间无其他标签页活动时）
 */
//NOTE: 可能会出现短时间内没有master的情况（master被关闭后，要等待心跳超时才能重新选出master）
export class MasterTabCoordinator {
  private static instance: MasterTabCoordinator | null = null;

  // 通道与消息相关
  private channelName: string;
  private channel: BroadcastChannel | null = null;
  private tabId: string;
  private isClosing: boolean = false;

  // 标签页状态
  private isMaster: boolean = true; // 默认初始就是master
  private isHidden: boolean = document.hidden;
  private isInitialized: boolean = false;
  private masterTabId: string | null = null;
  private lastActiveTime: number = Date.now(); // 最后活动时间

  // 心跳管理相关
  private lastHeartbeatReceived: number = 0; // 上次接收到外部心跳的时间
  private heartbeatInterval: number | null = null; // 心跳间隔
  private _isHeartbeatStopped: boolean = false; // 当前是否已停止心跳
  private heartbeatMode: "active" | "stopped" = "active"; // 心跳模式
  private otherTabsDetected: boolean = false; // 是否检测到其他标签页
  private heartbeatStopTimeout: number | null = null; // 停止心跳的计时器
  private firstHeartbeatAfterRestore: boolean = false; // 恢复心跳后的第一次心跳

  // 缓存已知标签页
  private knownTabsCache: Map<
    string,
    {
      lastSeen: number;
      isHidden?: boolean;
      lastActive?: number; // 最后活动时间
    }
  > = new Map();

  // 定时器
  private cleanupTimeout: number | null = null;
  private masterElectionTimeout: number | null = null;

  // 配置选项
  private options: TabManagerOptions;

  // 默认选项
  private static readonly DEFAULT_OPTIONS: TabManagerOptions = {
    channelName: "tab-manager",
    debug: false,
    allowMultipleTabs: true,
    heartbeatIntervalMs: 5000,
    heartbeatStopThresholdMs: 60000, // 多久没收到心跳后停止发送
    initialDetectionTimeMs: 5000, // 初始检测其他标签页的时间
    tabTimeoutMs: 10000,
    redirectUrl: "about:blank",
    redirectDelay: 100,
  };

  /**
   * 获取 TabManager 实例（单例模式）
   */
  public static getInstance(options?: Partial<TabManagerOptions>): MasterTabCoordinator {
    if (!MasterTabCoordinator.instance) {
      MasterTabCoordinator.instance = new MasterTabCoordinator(options);
    } else if (options) {
      // 更新现有实例的选项
      MasterTabCoordinator.instance.updateOptions(options);
    }

    return MasterTabCoordinator.instance;
  }

  /**
   * 私有构造函数，防止直接创建实例
   */
  private constructor(options?: Partial<TabManagerOptions>) {
    this.options = { ...MasterTabCoordinator.DEFAULT_OPTIONS, ...options };
    this.channelName = this.options.channelName;
    this.tabId = this.generateTabId();

    // 检查 BroadcastChannel 支持
    if (typeof BroadcastChannel === "undefined") {
      console.warn(
        "This browser doesn't support BroadcastChannel API. TabSyncCoordinator functionality will be limited",
      );
    }

    // 事件处理器集合
    this.eventHandlers = {
      master: [],
      slave: [],
      tabOpened: [],
      tabClosed: [],
      tabHidden: [],
      tabVisible: [],
      message: [],
      duplicate: [],
      stateReceived: [],
    };

    // 监听页面聚焦/点击/滚动事件，更新最后活动时间
    this.setupActivityTracking();
  }

  /**
   * 设置活动追踪
   */
  private setupActivityTracking(): void {
    // 页面获取焦点时更新活动时间
    window.addEventListener("focus", this.updateActivityTime);

    // 用户交互时更新活动时间
    // document.addEventListener("click", this.updateActivityTime);
    // document.addEventListener("keydown", this.updateActivityTime);
    // document.addEventListener("touchstart", this.updateActivityTime);
    // document.addEventListener("scroll", this.updateActivityTime, { passive: true });

    // 页面可见性变化时也更新活动时间
    document.addEventListener("visibilitychange", this.updateActivityTime);
  }

  /**
   * 更新活动时间
   */
  private updateActivityTime = (): void => {
    const now = Date.now();
    this.lastActiveTime = now;

    // 更新自己在缓存中的最后活动时间
    const tabInfo = this.knownTabsCache.get(this.tabId);
    if (tabInfo) {
      tabInfo.lastActive = now;
      this.setTabInfo(this.tabId, tabInfo);
    }

    // 注意：根据需求，不再因为用户活动自动恢复心跳
    // 只有当其他标签页发送消息时才恢复心跳

    // 如果心跳没有停止，并且标签页可见且不在关闭过程中，则发送一次心跳
    if (!this._isHeartbeatStopped && !this.isHidden && this.channel && !this.isClosing) {
      // 发送一次心跳，通知其他标签页当前活动状态
      this.sendHeartbeat();
    }
  };

  /**
   * 更新选项
   */
  public updateOptions(options: Partial<TabManagerOptions>): void {
    const previousOptions = { ...this.options };
    this.options = { ...this.options, ...options };

    // 如果通道名称已更改且通道已初始化，则需要重新初始化
    if (options.channelName && options.channelName !== this.channelName && this.channel) {
      this.channelName = this.options.channelName;
      this.reinitialize();
    }

    // 如果心跳相关配置已更改，更新心跳机制
    if (
      options.heartbeatIntervalMs !== undefined &&
      options.heartbeatIntervalMs !== previousOptions.heartbeatIntervalMs
    ) {
      this.updateHeartbeatSchedule();
    }
  }

  // 事件处理
  private eventHandlers: {
    master: Array<() => void>;
    slave: Array<() => void>;
    tabOpened: Array<(tabId: string, data: any) => void>;
    tabClosed: Array<(tabId: string) => void>;
    tabHidden: Array<(tabId: string) => void>;
    tabVisible: Array<(tabId: string) => void>;
    message: Array<(message: any, tabId: string) => void>;
    duplicate: Array<() => void>;
    stateReceived: Array<(state: any) => void>;
  };

  /**
   * 添加事件监听器
   */
  public on<K extends keyof TabManagerEvents>(event: K, handler: TabManagerEvents[K]): this {
    // @ts-ignore - 类型断言
    this.eventHandlers[event].push(handler);
    return this;
  }

  /**
   * 移除事件监听器
   */
  public off<K extends keyof TabManagerEvents>(event: K, handler: TabManagerEvents[K]): this {
    // @ts-ignore - 类型断言
    this.eventHandlers[event] = this.eventHandlers[event].filter((h) => h !== handler);
    return this;
  }

  /**
   * 触发事件
   */
  private emit<K extends keyof TabManagerEvents>(event: K, ...args: Parameters<TabManagerEvents[K]>): void {
    // @ts-ignore - 类型断言
    this.eventHandlers[event].forEach((handler) => handler(...args));
  }

  /**
   * 添加或更新标签页信息
   */
  private setTabInfo(
    tabId: string,
    info: {
      lastSeen: number;
      isHidden?: boolean;
      lastActive?: number;
    },
  ): void {
    this.knownTabsCache.set(tabId, info);
  }

  /**
   * 删除标签页信息
   */
  private deleteTabInfo(tabId: string): boolean {
    return this.knownTabsCache.delete(tabId);
  }

  /**
   * 更新心跳调度
   * 根据当前状态设置心跳频率
   */
  private updateHeartbeatSchedule(): void {
    // 清除现有的心跳定时器
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.heartbeatStopTimeout !== null) {
      clearTimeout(this.heartbeatStopTimeout);
      this.heartbeatStopTimeout = null;
    }

    // 如果已经在停止心跳模式，不重新设置计时器
    if (this._isHeartbeatStopped) {
      this.log("Heartbeat already stopped, not setting new heartbeat timer");
      return;
    }

    // 设置普通心跳间隔
    this.heartbeatInterval = window.setInterval(this.sendHeartbeat.bind(this), this.options.heartbeatIntervalMs);

    // 设置心跳停止定时器，如果长时间没收到其他标签页消息，停止心跳
    this.heartbeatStopTimeout = window.setTimeout(() => {
      const now = Date.now();
      // 只有当没有检测到其他标签页或长时间没收到心跳时才停止
      if (
        !this.otherTabsDetected ||
        (this.lastHeartbeatReceived > 0 && now - this.lastHeartbeatReceived > this.options.heartbeatStopThresholdMs)
      ) {
        this.stopHeartbeat();
      } else {
        // 重置计时器
        if (this.heartbeatStopTimeout !== null) {
          clearTimeout(this.heartbeatStopTimeout);
        }
        this.heartbeatStopTimeout = window.setTimeout(
          this.stopHeartbeat.bind(this),
          this.options.heartbeatStopThresholdMs,
        );
      }
    }, this.options.heartbeatStopThresholdMs);
  }

  /**
   * 停止心跳发送
   */
  private stopHeartbeat(): void {
    if (this._isHeartbeatStopped) return;

    this.log("No heartbeats received from other tabs for a long time, stopping heartbeat");

    // 清除心跳定时器
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this._isHeartbeatStopped = true;
    this.heartbeatMode = "stopped";

    // 发送一条最后的心跳，告知其他可能存在的标签页当前状态
    this.sendMessage("heartbeat", {
      masterTabId: this.isMaster ? this.tabId : this.masterTabId,
      isHidden: this.isHidden,
      lastActive: this.lastActiveTime,
      heartbeatMode: this.heartbeatMode,
    });
  }

  /**
   * 恢复心跳发送
   */
  private restoreHeartbeat(): void {
    if (!this._isHeartbeatStopped) return;

    this.log("Resuming heartbeat");
    this._isHeartbeatStopped = false;
    this.heartbeatMode = "active";
    this.otherTabsDetected = true;

    // 重新设置心跳计时器
    this.updateHeartbeatSchedule();
  }

  /**
   * 收到其他标签页消息时的处理
   * 这是恢复心跳的唯一途径
   */
  private handleExternalMessage(): void {
    const now = Date.now();
    this.lastHeartbeatReceived = now;
    this.otherTabsDetected = true;

    // 如果当前处于心跳停止模式，恢复心跳
    if (this._isHeartbeatStopped) {
      this.log("Detected activity from other tab, resuming heartbeat");
      this.restoreHeartbeat();

      // 立即发送一次心跳，确保当前状态及时通知其他标签页
      this.firstHeartbeatAfterRestore = true;
      setTimeout(this.sendHeartbeat.bind(this), 500);
    }

    // 重置心跳停止计时器
    if (this.heartbeatStopTimeout !== null) {
      clearTimeout(this.heartbeatStopTimeout);
    }
    this.heartbeatStopTimeout = window.setTimeout(this.stopHeartbeat.bind(this), this.options.heartbeatStopThresholdMs);
  }

  /**
   * 初始化 MasterTabCoordinator
   */
  public initialize(): this {
    if (this.channel) {
      this.log("Already initialized, skipping");
      return this;
    }

    this.log("Initializing MasterTabCoordinator");

    try {
      // 创建 BroadcastChannel
      if (typeof BroadcastChannel !== "undefined") {
        this.channel = new BroadcastChannel(this.channelName);
        this.channel.addEventListener("message", this.handleMessage);
      } else {
        console.warn("This browser doesn't support BroadcastChannel API, operating in limited functionality mode");
      }

      // 设置初始状态
      this.isHidden = document.hidden;
      this.lastActiveTime = Date.now();
      this.lastHeartbeatReceived = 0; // 初始化为0，表示还未收到过其他标签页的心跳

      // 添加当前标签页到已知标签页列表
      this.setTabInfo(this.tabId, {
        lastSeen: Date.now(),
        isHidden: document.hidden,
        lastActive: this.lastActiveTime,
      });

      // 发送初始消息
      this.sendMessage("tab-opened", {
        url: window.location.href,
        isHidden: document.hidden,
        lastActive: this.lastActiveTime,
      });

      // 请求其他标签页发送信息以便新标签页能获取完整的标签页列表
      setTimeout(() => {
        this.sendMessage("request-tabs-info");
      }, 100);

      // 设置心跳发送 - 初始使用正常频率，稍后会根据情况调整
      this.updateHeartbeatSchedule();

      // 立即发送心跳
      setTimeout(this.sendHeartbeat.bind(this), 300);

      // 设置清理过期标签页定时器
      this.cleanupTimeout = window.setTimeout(this.cleanupStaleTabs.bind(this), 2000);

      // 设置主标签页选举
      this.masterElectionTimeout = window.setTimeout(() => {
        this.electMaster();

        // 如果不是主标签页，请求状态同步
        setTimeout(() => {
          if (!this.isMaster && this.masterTabId) {
            this.requestStateSync();
          }
          this.isInitialized = true;

          // 在初始化完成后，检查是否有其他标签页
          // 如果经过一定时间后仍未检测到其他标签页，准备停止心跳
          setTimeout(() => {
            if (this.knownTabsCache.size <= 1) {
              this.log("No other tabs detected, preparing to stop heartbeat");
              this.otherTabsDetected = false;

              // 设置停止心跳的计时器
              if (this.heartbeatStopTimeout !== null) {
                clearTimeout(this.heartbeatStopTimeout);
              }
              this.heartbeatStopTimeout = window.setTimeout(
                this.stopHeartbeat.bind(this),
                this.options.heartbeatStopThresholdMs,
              );
            }
          }, this.options.initialDetectionTimeMs);
        }, 500);
      }, 1000);

      // 添加事件监听器
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      // 只监听unload事件，不监听beforeunload
      window.addEventListener("unload", this.handleBeforeUnload);

      return this;
    } catch (error) {
      console.error("Failed to initialize TabSyncCoordinator:", error);
      return this;
    }
  }

  /**
   * 重新初始化 (例如当通道名称改变时)
   */
  private reinitialize(): void {
    this.destroy();
    this.initialize();
  }

  /**
   * 销毁 TabManager
   */
  public destroy(): void {
    this.isClosing = true;

    // 移除活动追踪
    window.removeEventListener("focus", this.updateActivityTime);
    window.removeEventListener("visibilitychange", this.updateActivityTime);
    // document.removeEventListener("click", this.updateActivityTime);
    // document.removeEventListener("keydown", this.updateActivityTime);
    // document.removeEventListener("touchstart", this.updateActivityTime);
    // document.removeEventListener("scroll", this.updateActivityTime);

    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.heartbeatStopTimeout !== null) {
      clearTimeout(this.heartbeatStopTimeout);
      this.heartbeatStopTimeout = null;
    }

    if (this.cleanupTimeout !== null) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }

    if (this.masterElectionTimeout !== null) {
      clearTimeout(this.masterElectionTimeout);
      this.masterElectionTimeout = null;
    }

    // 发送关闭消息
    this.sendCloseMessage();

    // 移除事件监听器
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    // window.removeEventListener("beforeunload", this.handleBeforeUnload);
    window.removeEventListener("unload", this.handleBeforeUnload);

    // 关闭通道
    if (this.channel) {
      this.channel.removeEventListener("message", this.handleMessage);
      this.channel.close();
      this.channel = null;
    }

    // 清空标签页缓存
    this.knownTabsCache.clear();

    console.warn("MasterTabCoordinator destroyed");
  }

  /**
   * 生成唯一的标签页 ID
   */
  private generateTabId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * 日志记录
   */
  private log(...args: any[]): void {
    if (this.options.debug) {
      const prefix = `[TAG]: [${this.tabId}${this.isMaster ? "(Master)" : ""}]`;
      console.log(prefix, ...args);
    }
  }

  /**
   * 发送消息
   */
  private sendMessage(type: MessageType, additionalData: Record<string, any> = {}): void {
    if (!this.channel || this.isClosing) return;

    const message: TabMessage = {
      type,
      tabId: this.tabId,
      timestamp: Date.now(),
      heartbeatMode: this.heartbeatMode, // 添加心跳模式信息
      ...additionalData,
    };

    this.channel.postMessage(message);
    this.log("Sent message", type, additionalData);
  }

  /**
   * 发送心跳
   */
  private sendHeartbeat(): void {
    if (this.isClosing) return;

    // 如果心跳已停止且不是恢复后的第一次心跳，跳过发送
    if (this._isHeartbeatStopped && !this.firstHeartbeatAfterRestore) {
      return;
    }

    // 恢复后的第一次心跳发送完后，重置标志
    if (this.firstHeartbeatAfterRestore) {
      this.firstHeartbeatAfterRestore = false;
    }

    this.sendMessage("heartbeat", {
      masterTabId: this.isMaster ? this.tabId : this.masterTabId,
      isHidden: this.isHidden,
      lastActive: this.lastActiveTime,
      heartbeatMode: this.heartbeatMode,
    });

    // 更新当前标签页的 lastSeen 时间
    const tabInfo = this.knownTabsCache.get(this.tabId) || {
      lastSeen: Date.now(),
      isHidden: this.isHidden,
      lastActive: this.lastActiveTime,
    };
    tabInfo.lastSeen = Date.now();
    this.setTabInfo(this.tabId, tabInfo);
  }

  /**
   * 发送关闭消息
   */
  private sendCloseMessage(): void {
    this.sendMessage("tab-closed");
  }

  /**
   * 清理过期标签页
   */
  private cleanupStaleTabs(): void {
    if (this.isClosing) return;

    const now = Date.now();
    let hasStaleTab = false;
    let otherTabsExist = false;

    for (const [tabId, tabInfo] of this.knownTabsCache.entries()) {
      if (tabId !== this.tabId) {
        otherTabsExist = true;
      }

      if (tabId !== this.tabId && now - tabInfo.lastSeen > this.options.tabTimeoutMs) {
        this.log(`Detected stale tab ${tabId}, presumed closed`);
        this.knownTabsCache.delete(tabId);
        hasStaleTab = true;

        // 触发标签页关闭事件
        this.emit("tabClosed", tabId);
      }
    }

    // 更新是否检测到其他标签页
    if (this.otherTabsDetected !== otherTabsExist) {
      this.otherTabsDetected = otherTabsExist;

      // 如果不再有其他标签页，准备停止心跳
      if (!otherTabsExist && !this._isHeartbeatStopped) {
        this.log("No more other tabs detected, preparing to stop heartbeat");

        // 设置停止心跳的计时器
        if (this.heartbeatStopTimeout !== null) {
          clearTimeout(this.heartbeatStopTimeout);
        }
        this.heartbeatStopTimeout = window.setTimeout(
          this.stopHeartbeat.bind(this),
          this.options.heartbeatStopThresholdMs,
        );
      }
    }

    // 如果删除了过期标签页，且当前是主标签页或主标签页已过期，重新选举
    if (hasStaleTab && (this.isMaster || (this.masterTabId && !this.knownTabsCache.has(this.masterTabId)))) {
      this.electMaster();
    }

    // 继续定期清理
    this.cleanupTimeout = window.setTimeout(this.cleanupStaleTabs.bind(this), this.options.tabTimeoutMs / 3);
  }

  /**
   * 执行主标签页选举
   */
  private electMaster(): void {
    if (this.isClosing) return;

    // 首先清理过期标签页
    const now = Date.now();

    for (const [tabId, tabInfo] of this.knownTabsCache.entries()) {
      if (tabId !== this.tabId && now - tabInfo.lastSeen > this.options.tabTimeoutMs) {
        this.log(`Removing stale tab ${tabId} during election`);
        this.knownTabsCache.delete(tabId);
      }
    }

    // 检查是否所有标签页都是可见的或都是隐藏的
    let allVisible = true;
    let allHidden = true;

    for (const [_, tabInfo] of this.knownTabsCache.entries()) {
      if (tabInfo.isHidden) {
        allVisible = false;
      } else {
        allHidden = false;
      }
    }

    const allSameVisibility = allVisible || allHidden;

    // 候选主标签页ID
    let candidateTabId = this.tabId;
    let candidateIsHidden = this.isHidden;
    let candidateLastActive = this.lastActiveTime || 0;
    let candidateCreationTime = parseInt(candidateTabId.split("-")[0]);

    for (const [tabId, tabInfo] of this.knownTabsCache.entries()) {
      if (tabId === this.tabId) continue; // 自己已经是候选了

      const tabIsHidden = tabInfo.isHidden === true;
      const tabLastActive = tabInfo.lastActive || 0;
      const tabCreationTime = parseInt(tabId.split("-")[0]);

      if (allSameVisibility) {
        // 如果所有标签页都是可见的或都是隐藏的，优先选择最近活动的标签页
        if (tabLastActive > candidateLastActive) {
          candidateTabId = tabId;
          candidateIsHidden = tabIsHidden;
          candidateLastActive = tabLastActive;
          candidateCreationTime = tabCreationTime;
        }
        // 如果活动时间相同，选择最晚创建的标签页（时间戳最大）
        else if (tabLastActive === candidateLastActive && tabCreationTime > candidateCreationTime) {
          candidateTabId = tabId;
          candidateIsHidden = tabIsHidden;
          candidateLastActive = tabLastActive;
          candidateCreationTime = tabCreationTime;
        }
      } else {
        // 如果有些标签页可见，有些隐藏，优先选择可见的标签页
        // 如果当前候选是隐藏的，但当前检查的是可见的，切换到可见标签页
        if (candidateIsHidden && !tabIsHidden) {
          candidateTabId = tabId;
          candidateIsHidden = tabIsHidden;
          candidateLastActive = tabLastActive;
          candidateCreationTime = tabCreationTime;
        }
        // 如果两者可见性相同
        else if (candidateIsHidden === tabIsHidden) {
          // 在可见性相同的情况下，优先选择最近活动的标签页
          if (tabLastActive > candidateLastActive) {
            candidateTabId = tabId;
            candidateIsHidden = tabIsHidden;
            candidateLastActive = tabLastActive;
            candidateCreationTime = tabCreationTime;
          }
          // 如果活动时间也相同，选择最晚创建的标签页（时间戳最大）
          else if (tabLastActive === candidateLastActive && tabCreationTime > candidateCreationTime) {
            candidateTabId = tabId;
            candidateIsHidden = tabIsHidden;
            candidateLastActive = tabLastActive;
            candidateCreationTime = tabCreationTime;
          }
        }
      }
    }

    this.log("Master tab election result", {
      allVisible,
      allHidden,
      allSameVisibility,
      candidateTabId,
      candidateLastActive,
      isCurrent: candidateTabId === this.tabId,
    });

    // 如果当前标签页是选中的主标签页，设置为主标签页
    if (candidateTabId === this.tabId) {
      if (!this.isMaster) {
        this.log("Becoming master tab");
        this.isMaster = true;
        this.masterTabId = this.tabId;

        // 如果心跳未停止，发送成为主标签页的消息
        // 注意：如果心跳已停止，不会发送消息，除非收到其他标签页消息
        if (!this._isHeartbeatStopped) {
          this.sendMessage("become-master", {
            lastActive: this.lastActiveTime,
          });
        }

        // 触发主标签页事件
        this.emit("master");
      }
    } else {
      if (this.isMaster) {
        this.log("Becoming slave tab, new master is", candidateTabId);
        this.isMaster = false;

        // 触发从标签页事件
        this.emit("slave");
      }
      this.masterTabId = candidateTabId;
    }
  }

  /**
   * 处理重复标签页
   */
  private handleDuplicate(): void {
    if (this.options.allowMultipleTabs) {
      this.log("Multiple tabs detected, but multi-tab mode is enabled");
      return;
    }

    this.log("Duplicate tab detected, preparing to close");
    this.isClosing = true;

    // 触发重复标签页事件
    this.emit("duplicate");

    // 发送关闭消息并重定向
    this.sendCloseMessage();

    setTimeout(() => {
      window.location.href = this.options.redirectUrl;
    }, this.options.redirectDelay);
  }

  /**
   * 处理状态同步请求
   */
  private handleStateSyncRequest(requestingTabId: string): void {
    if (this.isMaster && this.options.state) {
      this.sendMessage("state-sync-response", {
        state: this.options.state,
        targetTabId: requestingTabId,
      });
    }
  }

  /**
   * 请求状态同步
   */
  public requestStateSync(): void {
    if (!this.isMaster && this.masterTabId) {
      // 即使心跳已停止，也发送此重要消息
      this.sendMessage("state-sync-request");
    }
  }

  /**
   * 处理页面可见性变化
   */
  private handleVisibilityChange = (): void => {
    const isCurrentlyHidden = document.hidden;

    if (this.isHidden !== isCurrentlyHidden) {
      this.isHidden = isCurrentlyHidden;

      // 更新最后活动时间
      this.lastActiveTime = Date.now();

      // 更新标签页可见性状态和活动时间
      const tabInfo = this.knownTabsCache.get(this.tabId);
      if (tabInfo) {
        tabInfo.isHidden = isCurrentlyHidden;
        tabInfo.lastActive = this.lastActiveTime;
        this.setTabInfo(this.tabId, tabInfo);
      }

      // 发送可见性变化消息 - 即使心跳已停止，也发送此重要消息
      this.sendMessage(isCurrentlyHidden ? "tab-hidden" : "tab-visible", {
        lastActive: this.lastActiveTime,
      });

      // 如果是从标签页且不在心跳停止状态，请求状态同步
      if (!isCurrentlyHidden && !this.isMaster && !this._isHeartbeatStopped) {
        setTimeout(this.requestStateSync.bind(this), 300);
      }

      // 标签页可见性变化会影响选举，重新选举主标签页
      // 但如果心跳已停止，则不执行选举，除非收到其他标签页消息
      if (!this._isHeartbeatStopped) {
        if (!isCurrentlyHidden) {
          // 立即进行选举
          this.electMaster();
        } else {
          // 页面隐藏时，延时选举
          setTimeout(this.electMaster.bind(this), 500);
        }
      }
    }
  };

  /**
   * 处理页面卸载
   */
  private handleBeforeUnload = (): void => {
    this.isClosing = true;
    this.sendCloseMessage();
  };

  /**
   * 处理接收到的消息
   */
  private handleMessage = (event: MessageEvent<TabMessage>): void => {
    const message = event.data;

    if (message.tabId === this.tabId) {
      // 忽略自己的消息
      return;
    }

    if (this.isClosing) {
      // 已经在关闭过程中，忽略消息
      return;
    }

    // 收到其他标签页的消息，处理心跳状态
    // 这是恢复心跳的唯一途径
    this.handleExternalMessage();

    this.log("Received message", message);

    // 更新已知标签页列表（除非是关闭消息）
    if (message.type !== "tab-closed") {
      const tabInfo = this.knownTabsCache.get(message.tabId) || {
        lastSeen: message.timestamp,
        lastActive: message.lastActive || message.timestamp,
      };

      tabInfo.lastSeen = message.timestamp;

      // 更新活动时间
      if (message.lastActive) {
        tabInfo.lastActive = message.lastActive;
      }

      // 更新隐藏状态
      if (message.type === "tab-hidden") {
        tabInfo.isHidden = true;
      } else if (message.type === "tab-visible") {
        tabInfo.isHidden = false;
      } else if (message.isHidden !== undefined) {
        tabInfo.isHidden = message.isHidden;
      }

      this.setTabInfo(message.tabId, tabInfo);
    }

    // 处理不同类型的消息
    switch (message.type) {
      case "request-tabs-info":
        // 回应自己的信息
        this.sendMessage("tab-info", {
          isHidden: this.isHidden,
          isMaster: this.isMaster,
          masterTabId: this.masterTabId,
          lastActive: this.lastActiveTime,
          heartbeatMode: this.heartbeatMode,
        });
        break;

      case "tab-info":
        // 无需特殊处理，已在上面更新了标签页信息
        break;

      case "tab-opened":
        // 触发标签页打开事件
        this.emit("tabOpened", message.tabId, message);

        if (!this.options.allowMultipleTabs) {
          this.handleDuplicate();
        } else {
          // 重新选举主标签页
          this.electMaster();
        }
        break;

      case "heartbeat":
        // 更新主标签页信息和标签页隐藏状态
        if (message.masterTabId) {
          this.masterTabId = message.masterTabId;

          // 如果认为自己是主标签页，但收到了其他主标签页的心跳，重新选举
          if (this.isMaster && message.masterTabId !== this.tabId) {
            this.electMaster();
          }
        }

        // 更新标签页隐藏状态变化事件
        if (message.isHidden !== undefined) {
          const tabInfo = this.knownTabsCache.get(message.tabId);
          if (tabInfo) {
            const wasHidden = tabInfo.isHidden;

            if (wasHidden !== message.isHidden) {
              // 触发标签页隐藏/可见事件
              if (message.isHidden) {
                this.emit("tabHidden", message.tabId);
              } else {
                this.emit("tabVisible", message.tabId);
              }

              // 标签页可见性改变，重新选举
              this.electMaster();
            }
          }
        }
        break;

      case "tab-closed":
        // 从已知标签页中移除
        this.deleteTabInfo(message.tabId);

        // 触发标签页关闭事件
        this.emit("tabClosed", message.tabId);

        // 如果主标签页关闭，重新选举
        if (this.masterTabId === message.tabId) {
          this.electMaster();
        }

        // 检查是否还有其他标签页存在
        if (this.knownTabsCache.size <= 1) {
          this.otherTabsDetected = false;
          this.log("All other tabs have closed, preparing to stop heartbeat");

          // 设置停止心跳的计时器
          if (this.heartbeatStopTimeout !== null) {
            clearTimeout(this.heartbeatStopTimeout);
          }
          this.heartbeatStopTimeout = window.setTimeout(
            this.stopHeartbeat.bind(this),
            this.options.heartbeatStopThresholdMs,
          );
        }
        break;

      case "tab-hidden":
        // 触发标签页隐藏事件
        this.emit("tabHidden", message.tabId);

        // 标签页可见性改变，重新选举
        setTimeout(this.electMaster.bind(this), 500);
        break;

      case "tab-visible":
        // 触发标签页可见事件
        this.emit("tabVisible", message.tabId);

        // 标签页可见性改变，重新选举
        setTimeout(this.electMaster.bind(this), 500);
        break;

      case "become-master":
        // 其他标签页宣布成为主标签页
        this.masterTabId = message.tabId;
        if (this.isMaster && message.tabId !== this.tabId) {
          // 检查另一个标签页的活动时间是否更新
          const otherTabInfo = this.knownTabsCache.get(message.tabId);
          const otherTabActive = otherTabInfo?.lastActive || message.lastActive || 0;

          // 如果另一个标签页的活动时间更近，或者当前标签页隐藏而其他标签页可见，则让出主标签页地位
          if (otherTabActive > this.lastActiveTime || (this.isHidden && otherTabInfo && !otherTabInfo.isHidden)) {
            this.log("Other tab is more recently active or more visible, yielding master status");
            this.isMaster = false;

            // 触发从标签页事件
            this.emit("slave");
          } else {
            // 否则维持当前主标签页状态，并稍后重新选举以解决冲突
            this.log("Maintaining master status, will re-elect later");
            setTimeout(this.electMaster.bind(this), 600);
          }
        }
        break;

      case "state-sync-request":
        // 处理状态同步请求
        this.handleStateSyncRequest(message.tabId);
        break;

      case "state-sync-response":
        // 接收状态同步响应
        if (message.targetTabId === this.tabId && message.state) {
          this.log("Received application state");
          this.emit("stateReceived", message.state);
        }
        break;

      case "custom":
        // 处理自定义消息
        if (message.data) {
          this.emit("message", message.data, message.tabId);
        }
        break;
    }
  };

  /**
   * 发送自定义消息到所有标签页
   * 即使心跳已停止，也会发送此消息
   */
  public broadcast(data: any): void {
    this.sendMessage("custom", { data });
  }

  /**
   * 获取当前是否为主标签页
   */
  public isMasterTab(): boolean {
    return this.isMaster;
  }

  /**
   * 获取当前标签页是否隐藏
   */
  public isTabHidden(): boolean {
    return this.isHidden;
  }

  /**
   * 获取当前标签页 ID
   */
  public getTabId(): string {
    return this.tabId;
  }

  /**
   * 获取主标签页 ID
   */
  public getMasterTabId(): string | null {
    return this.masterTabId;
  }

  /**
   * 获取已知标签页数量
   */
  public getTabCount(): number {
    return this.knownTabsCache.size;
  }

  /**
   * 获取所有已知标签页
   */
  public getKnownTabs(): Map<string, { lastSeen: number; isHidden?: boolean; lastActive?: number }> {
    // 返回已知标签页的副本
    return new Map(this.knownTabsCache);
  }

  /**
   * 获取当前心跳模式
   */
  public getHeartbeatMode(): "active" | "stopped" {
    return this.heartbeatMode;
  }

  /**
   * 手动更新活动时间
   * 可在用户重要交互时调用
   */
  public updateLastActiveTime(): void {
    this.updateActivityTime();
  }

  /**
   * 获取心跳是否已停止
   */
  public isHeartbeatStopped(): boolean {
    return this._isHeartbeatStopped;
  }

  /**
   * 设置要同步的应用状态
   */
  public setState(state: any): void {
    this.options.state = state;

    // 如果是主标签页，将状态广播给从标签页
    if (this.isMaster) {
      // 即使心跳已停止，也发送此重要消息
      this.sendMessage("state-broadcast", { state });
    }
  }

  /**
   * 获取当前应用状态
   */
  public getState(): any {
    return this.options.state;
  }
}

// 类型定义
type MessageType =
  | "tab-opened"
  | "tab-closed"
  | "tab-hidden"
  | "tab-visible"
  | "heartbeat"
  | "become-master"
  | "state-sync-request"
  | "state-sync-response"
  | "state-broadcast"
  | "custom"
  | "request-tabs-info"
  | "tab-info";

interface TabMessage {
  type: MessageType;
  tabId: string;
  timestamp: number;
  url?: string;
  state?: any;
  targetTabId?: string;
  masterTabId?: string;
  isHidden?: boolean;
  isMaster?: boolean;
  lastActive?: number; // 最后活动时间
  heartbeatMode?: "active" | "stopped"; // 心跳模式
  data?: any;
}

interface TabManagerOptions {
  channelName: string;
  debug: boolean;
  allowMultipleTabs: boolean;
  heartbeatIntervalMs: number;
  heartbeatStopThresholdMs: number; // 多久没收到心跳后停止发送
  initialDetectionTimeMs: number; // 初始检测其他标签页的时间
  tabTimeoutMs: number;
  redirectUrl: string;
  redirectDelay: number;
  state?: any;
}

// 事件类型定义
interface TabManagerEvents {
  master: () => void;
  slave: () => void;
  tabOpened: (tabId: string, data: any) => void;
  tabClosed: (tabId: string) => void;
  tabHidden: (tabId: string) => void;
  tabVisible: (tabId: string) => void;
  message: (message: any, tabId: string) => void;
  duplicate: () => void;
  stateReceived: (state: any) => void;
}

export default MasterTabCoordinator;

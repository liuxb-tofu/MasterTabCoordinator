MasterTabCoordinator 是一个用于多标签页环境的主从标签管理库，支持自动主从选举、标签页间消息同步、单实例控制、状态同步等功能。适用于需要在浏览器多标签页间实现唯一主实例、数据一致性或跨标签通信的前端应用场景。核心特性包括：
- 主从标签页自动选举，确保全局唯一主标签
- 支持标签页的打开、关闭、隐藏、显示检测
- 基于 BroadcastChannel 实现高效消息广播与状态同步
- 可选单实例应用模式，防止多标签冲突
- 心跳机制与自动失活检测，提升健壮性
- 简单易用的事件监听与自定义消息扩展

```bash
npm install @liuxb001/master-tab-coordinator
```

### 基本用法

```typescript
import { MasterTabCoordinator } from '@liuxb001/master-tab-coordinator';

// 创建实例（单例模式）
const tabCoordinator = MasterTabCoordinator.getInstance({
  channelName: 'my-app-tabs', // 自定义通道名称
  debug: true, // 启用调试日志
});

// 初始化
tabCoordinator.init();

// 监听主标签事件
tabCoordinator.on('master', () => {
  console.log('此标签页现在是主标签页');
  // 在主标签页执行特定操作
});

// 监听从标签事件
tabCoordinator.on('slave', () => {
  console.log('此标签页现在是从标签页');
  // 在从标签页执行特定操作
});

// 发送消息到所有其他标签页
tabCoordinator.sendMessage({
  type: 'custom-event',
  data: { key: 'value' }
});

// 监听来自其他标签页的消息
tabCoordinator.on('message', (message, sourceTabId) => {
  console.log(`收到来自标签页 ${sourceTabId} 的消息:`, message);
});
```

## API 参考

### 配置选项

```typescript
interface TabManagerOptions {
  channelName: string;         // 通信通道名称
  debug: boolean;              // 是否启用调试日志
  allowMultipleTabs: boolean;  // 是否允许多标签页（false时实现单实例模式）
  heartbeatIntervalMs: number; // 心跳间隔（毫秒）
  heartbeatStopThresholdMs: number; // 多久没收到心跳后停止发送（毫秒）
  initialDetectionTimeMs: number;   // 初始检测其他标签页的时间（毫秒）
  tabTimeoutMs: number;        // 标签页超时时间（毫秒）
  redirectUrl: string;         // 单实例模式下重定向URL
  redirectDelay: number;       // 重定向延迟（毫秒）
}
```

### 主要方法

- `getInstance(options?)`: 获取单例实例
- `init()`: 初始化协调器
- `on(eventName, handler)`: 注册事件监听器
- `off(eventName, handler)`: 移除事件监听器
- `sendMessage(message)`: 发送消息到其他标签页
- `isMasterTab()`: 检查当前标签页是否为主标签页
- `getTabId()`: 获取当前标签页ID
- `getMasterTabId()`: 获取主标签页ID
- `getKnownTabs()`: 获取所有已知标签页信息
- `setState(state)`: 设置要同步的状态
- `getState()`: 获取当前同步状态

### 事件类型

- `master`: 当前标签页成为主标签页
- `slave`: 当前标签页成为从标签页
- `tabOpened`: 新标签页打开
- `tabClosed`: 标签页关闭
- `tabHidden`: 标签页隐藏
- `tabVisible`: 标签页可见
- `message`: 收到消息
- `duplicate`: 检测到重复标签页（单实例模式下）
- `stateReceived`: 收到状态更新

## 项目结构

```
.
├── src/                  # 源代码目录
│   └── MasterTabCoordinator.ts  # 主要实现文件
├── dist/                 # 编译输出目录 (git忽略)
├── node_modules/         # 依赖目录 (git忽略)
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
├── .eslintrc.js          # ESLint 配置
├── .prettierrc           # Prettier 配置
└── .gitignore            # Git 忽略配置
```

## 开发

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 代码检查
npm run lint

# 格式化代码
npm run format
```

## 许可证

Apache License 2.0
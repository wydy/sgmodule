/*
 * YouTube 净化与全功能增强脚本 (重构易读版)
 * 支持功能：去视频广告、净化首页/推荐流（无广告与 Shorts 货架）、解锁后台播放与画中画(PiP)
 * 兼容环境：Surge, Shadowrocket, Quantumult X, Loon
 */

// ==================== 1. 跨平台环境适配层 ====================
const $ = {
    isSurge: typeof $environment !== "undefined" && $environment["surge-version"],
    isQuantX: typeof $task !== "undefined",
    isLoon: typeof $loon !== "undefined",
    log: (msg) => console.log(`[YT-Enhance] ${msg}`),
    // 统一获取二进制响应体
    getResponseBody: () => {
        if (typeof $response === "undefined" || !$response.body) return null;
        if ($.isQuantX) {
            // Quantumult X 的 body 可能是 Uint8Array 或 ArrayBuffer
            return typeof $response.body === "string" ? null : new Uint8Array($response.body);
        }
        return new Uint8Array($response.body);
    },
    // 统一完成回调
    done: (data) => {
        if (data && data.body) {
            if ($.isQuantX) {
                $done({ body: data.body.buffer });
            } else {
                $done({ body: data.body });
            }
        } else {
            $done({});
        }
    }
};

// ==================== 2. 轻量级 Protobuf 核心解包/封包类 ====================
class ProtoMessage {
    constructor(buffer) {
        this.fields = []; // 存放解析后的节点 { tag, type, val }
        if (buffer) this.decode(buffer);
    }

    /**
     * 将二进制数据流解码为结构化对象数组
     */
    decode(buffer) {
        let pos = 0;
        const len = buffer.length;
        while (pos < len) {
            // 读取 Varint 格式的 Key
            let key = 0, shift = 0, b;
            do {
                b = buffer[pos++];
                key |= (b & 0x7F) << shift;
                shift += 7;
            } while (b & 0x80);

            const tag = key >> 3;       // 字段标识 ID
            const type = key & 0x07;    // 传输类型 (Wire Type)
            let val;

            if (type === 0) { // Varint 变长整数 (包含 bool, enum)
                let start = pos;
                while (buffer[pos++] & 0x80) {}
                val = buffer.subarray(start, pos); 
            } else if (type === 1) { // 64-bit 固定长度
                val = buffer.subarray(pos, pos + 8);
                pos += 8;
            } else if (type === 2) { // Length-delimited 长度限定类型 (String, Embedded Message, Bytes)
                let l = 0, lShift = 0, lb;
                do {
                    lb = buffer[pos++];
                    l |= (lb & 0x7F) << lShift;
                    lShift += 7;
                } while (lb & 0x80);
                val = buffer.subarray(pos, pos + l);
                pos += l;
            } else if (type === 5) { // 32-bit 固定长度
                val = buffer.subarray(pos, pos + 4);
                pos += 4;
            } else {
                throw new Error(`遇到未知的 Wire Type ${type}，位于偏移量：${pos}`);
            }

            this.fields.push({ tag, type, val });
        }
    }

    /**
     * 将结构化对象重新序列化为标准的二进制 Protobuf 数据流
     */
    encode() {
        const chunks = [];
        for (const f of this.fields) {
            // 写入 Key
            let key = (f.tag << 3) | f.type;
            while (key > 0x7F) {
                chunks.push((key & 0x7F) | 0x80);
                key >>>= 7;
            }
            chunks.push(key & 0x7F);

            // 如果是类型 2，需要先写入后续数据的总长度
            if (f.type === 2) {
                let l = f.val.length;
                while (l > 0x7F) {
                    chunks.push((l & 0x7F) | 0x80);
                    l >>>= 7;
                }
                chunks.push(l & 0x7F);
            }
            
            // 写入字段主体二进制数据
            for (let i = 0; i < f.val.length; i++) {
                chunks.push(f.val[i]);
            }
        }
        return new Uint8Array(chunks);
    }

    // 查找指定 Tag 的首个节点
    find(tag) {
        return this.fields.find(f => f.tag === tag);
    }

    // 根据黑名单批量剔除节点
    filter(tagsSet) {
        this.fields = this.fields.filter(f => !tagsSet.has(f.tag));
    }

    // 强行写入或覆写一个 Varint 值 (例如将状态码改为 1)
    setVarint(tag, value) {
        const chunks = [];
        let val = value;
        while (val > 0x7F) {
            chunks.push((val & 0x7F) | 0x80);
            val >>>= 7;
        }
        chunks.push(val & 0x7F);
        const rawBytes = new Uint8Array(chunks);

        const existing = this.find(tag);
        if (existing) {
            existing.type = 0;
            existing.val = rawBytes;
        } else {
            this.fields.push({ tag, type: 0, val: rawBytes });
        }
    }
}

// ==================== 3. YouTube 业务逻辑处理器 ====================
class YouTubeProcessor {
    /**
     * 核心路由：解析 /v1/player 接口 (控制播放器权限与广告)
     */
    static processPlayer(buffer) {
        const msg = new ProtoMessage(buffer);
        // 移除视频流中的原生广告投放与追踪
        msg.filter(new Set([2, 3, 8]));
        
        // 解锁后台播放与画中画
        const playabilityStatusField = msg.find(7);
        if (playabilityStatusField && playabilityStatusField.type === 2) {
            const statusMsg = new ProtoMessage(playabilityStatusField.val);
            statusMsg.setVarint(1, 1); // 状态强行改为 1 (OK)
            statusMsg.filter(new Set([2])); // 移除限制原因文本
            playabilityStatusField.val = statusMsg.encode();
        }
        return msg.encode();
    }

    /**
     * 修复版：针对 /v1/browse (首页、订阅、搜索) 进行精确路径过滤
     */
    static purgeBrowse(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            
            for (const field of msg.fields) {
                // 【安全路径保护】只在特定的结构骨架 Tag (1:contents, 3:tabs, 4:content) 中向下递归
                if (field.type === 2 && (field.tag === 1 || field.tag === 3 || field.tag === 4)) {
                    field.val = YouTubeProcessor.purgeBrowse(field.val);
                }
                
                // 精准定位到 richGridRenderer.contents (Tag 1) 信息流骨干阵列
                if (field.tag === 1 && field.type === 2) {
                    const gridMsg = new ProtoMessage(field.val);
                    const filteredFields = [];
                    
                    for (const item of gridMsg.fields) {
                        // 1. 过滤普通信息流格子 (richItemRenderer)
                        if (item.tag === 1 && item.type === 2) {
                            const itemMsg = new ProtoMessage(item.val);
                            const contentField = itemMsg.find(1); // content 节点
                            if (contentField && contentField.type === 2) {
                                const contentMsg = new ProtoMessage(contentField.val);
                                // 判定：若不包含正常视频(Tag 1)或触发了广告节点(Tag 5, 7)，则执行剔除
                                if (!contentMsg.find(1) || contentMsg.find(5) || contentMsg.find(7)) {
                                    continue; 
                                }
                            }
                        }
                        // 2. 过滤全宽组合货架 (richSectionRenderer，如 Shorts、活动横幅)
                        else if (item.tag === 2 && item.type === 2) {
                            const sectionMsg = new ProtoMessage(item.val);
                            const contentField = sectionMsg.find(1);
                            if (contentField && contentField.type === 2) {
                                const contentMsg = new ProtoMessage(contentField.val);
                                // 判定：若包含 reelShelfRenderer (Tag 8: Shorts 聚合货架)，则整个栏目剔除
                                if (contentMsg.find(8)) {
                                    continue; 
                                }
                            }
                        }
                        filteredFields.push(item);
                    }
                    gridMsg.fields = filteredFields;
                    field.val = gridMsg.encode();
                }
            }
            return msg.encode();
        } catch (e) {
            return buffer; // 发生意外时安全回滚
        }
    }

    /**
     * 修复版：针对 /v1/next (视频下方推荐流) 进行精准结构拦截
     */
    static purgeNext(buffer) {
        try {
            const msg = new ProtoMessage(buffer);
            
            for (const field of msg.fields) {
                // 【安全路径保护】仅穿梭于推荐流骨架 (1:contents, 2:secondaryResults)
                if (field.type === 2 && (field.tag === 1 || field.tag === 2)) {
                    field.val = YouTubeProcessor.purgeNext(field.val);
                }
                
                // 精准定位到 secondaryResultsRenderer.results (Tag 1) 推荐列表容器
                if (field.tag === 1 && field.type === 2) {
                    const resultsMsg = new ProtoMessage(field.val);
                    // 严格白名单过滤：只保留真正的推荐视频(Tag 1: compactVideoRenderer) 与 加载更多按钮(Tag 2)
                    // 直接在二进制流中抹除 Tag 3 (推荐流中的 Shorts 货架) 以及 Tag 11, 12 (推荐流混合广告)
                    resultsMsg.fields = resultsMsg.fields.filter(item => item.tag === 1 || item.tag === 2);
                    field.val = resultsMsg.encode();
                }
            }
            return msg.encode();
        } catch (e) {
            return buffer;
        }
    }
}

// ==================== 4. 运行时入口点 (Execution) ====================
(() => {
    const url = $request.url;
    const rawBody = $.getResponseBody();

    if (!rawBody) {
        $.done({});
        return;
    }

    try {
        let modifiedBody = null;

        if (url.includes("/v1/player")) {
            $.log("正在解锁播放器权限与去除视频广告...");
            modifiedBody = YouTubeProcessor.processPlayer(rawBody);
        } 
        else if (url.includes("/v1/browse")) {
            $.log("正在精准净化首页/订阅流 (移除广告与 Shorts)...");
            modifiedBody = YouTubeProcessor.purgeBrowse(rawBody);
        } 
        else if (url.includes("/v1/next")) {
            $.log("正在精准净化相关视频推荐流 (移除广告与 Shorts)...");
            modifiedBody = YouTubeProcessor.purgeNext(rawBody);
        } 
        else if (url.includes("/v1/search")) {
            $.log("正在精准净化搜索结果流...");
            // 搜索结果结构与 browse 骨架高度一致，复用安全路由净化
            modifiedBody = YouTubeProcessor.purgeBrowse(rawBody);
        }

        if (modifiedBody) {
            $.done({ body: modifiedBody });
        } else {
            $.done({});
        }
    } catch (err) {
        $.log(`运行时发生异常: ${err.message}`);
        $.done({});
    }
})();

// 映射别名兼容
YouTubeProcessor.crunchFeeds = YouTubeProcessor.purgeFeeds;

/**
 * Light Manager Plugin - 灯光管理器插件
 *
 * 功能：
 * 1. 创建和管理多种类型的灯光（HemisphericLight, DirectionalLight, PointLight, SpotLight）
 * 2. 调整灯光颜色和强度
 * 3. 使用Gizmo移动灯光位置
 * 4. 支持显示/隐藏灯光和Gizmo
 * 5. 支持设置"最大同时生效灯光数"，解决 Babylon.js 默认单个材质最多受 4 盏灯影响、
 *    导致创建多盏灯时"灯光生效数量过少"的问题
 * 6. 为每个灯光（半球光除外）提供 ShadowGenerator 阴影发生器，可自由开关，
 *    并支持调整阴影贴图大小与启用模糊阴影（PCF）；半球光不支持阴影
 */

var exports = {};

(function() {
    // UI组件引用
    var Slider = mp.ui.Slider;
    var Dropdown = mp.ui.Dropdown;
    var RGBColorPicker = mp.ui.RGBColorPicker;
    var VectorInput = mp.ui.VectorInput;
    var toast = mp.ui.toast;

    // 插件状态
    var container = null;
    var scene = null;
    var pluginContext = null;
    var lights = new Map();
    var gizmoManager = null;
    var currentGizmoLight = null;
    var unsubscribers = [];
    var lightCounter = 0;

    // 最大同时生效灯光数（Babylon.js 默认 4，超过后多余的灯不会对材质生效）
    var MAX_LIGHTS_MIN = 4;
    var MAX_LIGHTS_MAX = 8;
    var MAX_LIGHTS_DEFAULT = 8;
    // 灯光管理器硬上限：无论入口如何，插件自身最多创建/执行8盏灯光。
    var PLUGIN_LIGHT_LIMIT = 8;
    var maxSimultaneousLights = MAX_LIGHTS_DEFAULT;
    var maxLightsSlider = null;

    // V2 全局灯光控制：不改动原有灯光预设逻辑，只在其外围增加控制层。
    var globalLightEnabled = true;
    var globalMeshVisible = true;
    var globalIntensityMultiplier = 1.0;
    var pbrCompensationEnabled = true;
    var PBR_DIRECT_INTENSITY = 2.0;
    var USER_PRESET_MAX = 12;
    var USER_PRESET_LIGHT_MAX = 8;
    var userLightPresets = [];
    var userPresetDropdown = null;
    var userPresetDropdownHost = null;
    var userPresetDesc = null;

    // 阴影（ShadowGenerator）常量与默认配置
    var SHADOW_MAP_SIZES = [
        { value: 512, label: '512' },
        { value: 1024, label: '1024 (推荐)' },
        { value: 2048, label: '2048' },
        { value: 4096, label: '4096' }
    ];
    var SHADOW_MAP_SIZE_DEFAULT = 1024;

    // 灯光类型定义
    var LIGHT_TYPES = [
        { value: 'hemispheric', label: '环境光 (Hemispheric)' },
        { value: 'directional', label: '方向光 (Directional)' },
        { value: 'point', label: '点光源 (Point)' },
        { value: 'spot', label: '聚光灯 (Spot)' }
    ];

    // 灯光组合预设：仅使用聚光灯，不再使用方向光。
    // 位置按“前左上 / 前右上 / 正后方 / 后左上 / 后右上”等 45° 空间方向设计。
    // 每个预设的所有灯光 intensity 总和均 <= 0.75，优先保证阴影层次与画面稳定性。
    var LIGHT_PRESETS = [
        {
            value: 'front_dual_45',
            label: '前方45°双侧',
            description: '前左上 + 前右上双聚光，人物正面立体感均衡；总亮度 0.70。',
            lights: [
                { type: 'spot', pos: [-35, 60, 35], color: {r:1,g:1,b:1}, intensity: 0.35, angle: 34, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [ 35, 60, 35], color: {r:1,g:1,b:1}, intensity: 0.35, angle: 34, target: [0, 8, 0], shadow: true }
            ]
        },
        {
            value: 'front_three_45',
            label: '前方45°三灯',
            description: '前左、前右 + 正前高位补光，阴影更均匀；总亮度 0.75。',
            lights: [
                { type: 'spot', pos: [-38, 65, 38], color: {r:1,g:1,b:1}, intensity: 0.25, angle: 32, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [ 38, 65, 38], color: {r:1,g:1,b:1}, intensity: 0.25, angle: 32, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [  0, 58, 48], color: {r:1,g:1,b:1}, intensity: 0.25, angle: 38, target: [0, 8, 0], shadow: true }
            ]
        },
        {
            value: 'rear_rim_single',
            label: '正后方轮廓光',
            description: '正后方高位单聚光，突出头发、肩部与服装轮廓；总亮度 0.70。',
            lights: [
                { type: 'spot', pos: [0, 65, -45], color: {r:1,g:1,b:1}, intensity: 0.70, angle: 30, target: [0, 10, 0], shadow: true }
            ]
        },
        {
            value: 'rear_dual_45',
            label: '后方45°双侧',
            description: '后左上 + 后右上双轮廓光，适合舞蹈与背光镜头；总亮度 0.70。',
            lights: [
                { type: 'spot', pos: [-40, 62, -38], color: {r:1,g:1,b:1}, intensity: 0.35, angle: 32, target: [0, 9, 0], shadow: true },
                { type: 'spot', pos: [ 40, 62, -38], color: {r:1,g:1,b:1}, intensity: 0.35, angle: 32, target: [0, 9, 0], shadow: true }
            ]
        },
        {
            value: 'diagonal_four_high',
            label: '四角高位交叉',
            description: '四个45°方向高位交叉布光，形成完整空间层次；总亮度 0.72。',
            lights: [
                { type: 'spot', pos: [-42, 68, 42], color: {r:1,g:1,b:1}, intensity: 0.18, angle: 34, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [ 42, 68, 42], color: {r:1,g:1,b:1}, intensity: 0.18, angle: 34, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [-42, 56, -42], color: {r:1,g:1,b:1}, intensity: 0.18, angle: 34, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [ 42, 56, -42], color: {r:1,g:1,b:1}, intensity: 0.18, angle: 34, target: [0, 8, 0], shadow: true }
            ]
        },
        {
            value: 'high_low_cross',
            label: '高低错落交叉',
            description: '前左/前右高位 + 后方低位轮廓，制造明显的纵深感；总亮度 0.75。',
            lights: [
                { type: 'spot', pos: [-38, 68, 38], color: {r:1,g:1,b:1}, intensity: 0.28, angle: 32, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [ 38, 68, 38], color: {r:1,g:1,b:1}, intensity: 0.28, angle: 32, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [  0, 28, -42], color: {r:1,g:1,b:1}, intensity: 0.19, angle: 42, target: [0, 7, 0], shadow: true }
            ]
        },
        {
            value: 'low_side_cinematic',
            label: '低位电影侧光',
            description: '前左低位 + 后右低位形成斜向光路，适合剧情、近景和强明暗镜头；总亮度 0.70。',
            lights: [
                { type: 'spot', pos: [-30, 24, 34], color: {r:1,g:0.86,b:0.72}, intensity: 0.35, angle: 38, target: [0, 8, 0], shadow: true },
                { type: 'spot', pos: [ 34, 22, -34], color: {r:0.72,g:0.84,b:1}, intensity: 0.35, angle: 38, target: [0, 9, 0], shadow: true }
            ]
        }
    ];

    // 彩色氛围灯预设：作为基础白光布光之上的第二层色彩光场。
    // 仅使用聚光灯；每组总强度 <= 1.0，位置遵循前左/前右/正后/后左/后右等45°空间方向。
    var ATMOSPHERE_PRESETS = [
        {
            value: 'blue_purple_stage', label: '蓝紫舞台',
            description: '前方弱蓝 + 后左蓝紫 + 后右紫，强化轮廓与舞台纵深；总亮度 0.78。',
            lights: [
                { type:'spot', pos:[-34,62,34], color:{r:0.18,g:0.32,b:1.0}, intensity:0.18, angle:36, target:[0,8,0], shadow:false },
                { type:'spot', pos:[-42,64,-38], color:{r:0.22,g:0.08,b:1.0}, intensity:0.30, angle:34, target:[0,9,0], shadow:false },
                { type:'spot', pos:[42,58,-40], color:{r:0.68,g:0.10,b:1.0}, intensity:0.30, angle:34, target:[0,9,0], shadow:false }
            ]
        },
        {
            value: 'cyan_orange_cinema', label: '青橙电影',
            description: '前左暖橙、后右高位青蓝，形成暖主体与冷轮廓的电影式色彩分离；总亮度 0.70。',
            lights: [
                { type:'spot', pos:[-38,60,38], color:{r:1.0,g:0.28,b:0.05}, intensity:0.28, angle:36, target:[0,8,0], shadow:false },
                { type:'spot', pos:[38,66,-38], color:{r:0.02,g:0.78,b:1.0}, intensity:0.32, angle:34, target:[0,9,0], shadow:false },
                { type:'spot', pos:[0,52,-48], color:{r:0.03,g:0.42,b:1.0}, intensity:0.10, angle:30, target:[0,10,0], shadow:false }
            ]
        },
        {
            value: 'red_blue_stage', label: '红蓝舞台',
            description: '后左红、后右蓝，形成强烈双色轮廓；前方仅用极低强度蓝光补空间；总亮度 0.75。',
            lights: [
                { type:'spot', pos:[-42,64,-38], color:{r:1.0,g:0.03,b:0.05}, intensity:0.34, angle:32, target:[0,9,0], shadow:false },
                { type:'spot', pos:[42,64,-38], color:{r:0.03,g:0.18,b:1.0}, intensity:0.34, angle:32, target:[0,9,0], shadow:false },
                { type:'spot', pos:[0,50,44], color:{r:0.10,g:0.35,b:1.0}, intensity:0.07, angle:40, target:[0,8,0], shadow:false }
            ]
        },
        {
            value: 'pink_violet_dream', label: '紫粉梦幻',
            description: '后左紫、后右高饱和粉紫，配合前方极弱粉光，适合梦幻、二次元与柔和舞台；总亮度 0.68。',
            lights: [
                { type:'spot', pos:[-40,62,-40], color:{r:0.48,g:0.04,b:1.0}, intensity:0.30, angle:35, target:[0,9,0], shadow:false },
                { type:'spot', pos:[40,58,-38], color:{r:1.0,g:0.08,b:0.55}, intensity:0.30, angle:35, target:[0,9,0], shadow:false },
                { type:'spot', pos:[-34,46,34], color:{r:1.0,g:0.16,b:0.65}, intensity:0.08, angle:38, target:[0,8,0], shadow:false }
            ]
        },
        {
            value: 'cyan_green_night', label: '青绿夜景',
            description: '后方青绿环境色 + 右后蓝色轮廓 + 低位青光，模拟夜景环境反射；总亮度 0.72。',
            lights: [
                { type:'spot', pos:[0,68,-46], color:{r:0.02,g:1.0,b:0.72}, intensity:0.34, angle:34, target:[0,10,0], shadow:false },
                { type:'spot', pos:[42,56,-38], color:{r:0.02,g:0.35,b:1.0}, intensity:0.28, angle:35, target:[0,9,0], shadow:false },
                { type:'spot', pos:[-32,24,36], color:{r:0.03,g:0.75,b:0.72}, intensity:0.10, angle:42, target:[0,7,0], shadow:false }
            ]
        },
        {
            value: 'warm_gold', label: '暖金氛围',
            description: '前左暖金 + 后右橙红 + 正后低强度暖光，模拟舞台暖色实景灯；总亮度 0.70。',
            lights: [
                { type:'spot', pos:[-36,58,38], color:{r:1.0,g:0.48,b:0.08}, intensity:0.30, angle:36, target:[0,8,0], shadow:false },
                { type:'spot', pos:[38,62,-38], color:{r:1.0,g:0.12,b:0.03}, intensity:0.28, angle:34, target:[0,9,0], shadow:false },
                { type:'spot', pos:[0,48,-44], color:{r:1.0,g:0.62,b:0.18}, intensity:0.12, angle:40, target:[0,8,0], shadow:false }
            ]
        },
        {
            value: 'low_color_cross', label: '低位双色交叉',
            description: '低位前左紫红 + 低位后右青蓝，高位正后弱蓝，制造明显的色彩交叉与纵深；总亮度 0.64。',
            lights: [
                { type:'spot', pos:[-30,22,36], color:{r:1.0,g:0.05,b:0.38}, intensity:0.24, angle:42, target:[0,8,0], shadow:false },
                { type:'spot', pos:[34,24,-36], color:{r:0.02,g:0.72,b:1.0}, intensity:0.24, angle:42, target:[0,8,0], shadow:false },
                { type:'spot', pos:[0,64,-46], color:{r:0.08,g:0.20,b:1.0}, intensity:0.16, angle:34, target:[0,10,0], shadow:false }
            ]
        }
    ];

    // 快速选色：公共颜色表，所有灯光类型共用。
    var QUICK_COLOR_HUES = [
        { name:'红', h:0 }, { name:'橙', h:30 }, { name:'黄', h:60 },
        { name:'绿', h:120 }, { name:'青', h:180 }, { name:'蓝', h:220 }, { name:'紫', h:275 }
    ];
    var QUICK_COLOR_LEVELS = [
        { name:'淡', s:0.28, l:0.78 },
        { name:'柔', s:0.52, l:0.68 },
        { name:'中', s:0.76, l:0.58 },
        { name:'鲜', s:0.94, l:0.50 },
        { name:'浓', s:1.00, l:0.40 }
    ];

    /**
     * 创建面板
     * @param {Object} context - 插件上下文
     * @returns {HTMLElement} 面板元素
     */
    exports.createPanel = function(context) {
        scene = context.scene;
        pluginContext = context;

        container = document.createElement('div');
        container.style.cssText = 'padding: 16px; color: var(--text-primary); display: flex; flex-direction: column; gap: 16px; overflow-y: auto; height: 100%;';

        // 标题
        var header = document.createElement('div');
        header.style.cssText = 'font-size: 16px; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 8px;';
        header.textContent = '灯光管理器';
        container.appendChild(header);

        // V2 全局控制区域（原有灯光预设区域保持不变）
        var settingsSection = createSettingsSection();
        container.appendChild(settingsSection);

        // 原版灯光组合预设区域：刻意保持原样，不改 UI 与预设内容。
        var presetSection = createPresetSection();
        container.appendChild(presetSection);

        // V2 用户偏好与导入分享区域
        var userSection = createUserPresetSection();
        container.appendChild(userSection);

        var operationSection = createV2OperationSection();
        container.appendChild(operationSection);

        // 创建新灯光区域
        var createSection = createCreateLightSection();
        container.appendChild(createSection);

        // 灯光列表区域
        var listSection = createLightListSection();
        container.appendChild(listSection);

        // 初始化Gizmo管理器
        initGizmoManager();

        // 监听场景变化事件
        var unsub = context.eventBus.on('scene:reset', function() {
            clearAllLights();
        });
        unsubscribers.push(unsub);

        // 监听模型加载事件：新加载模型的材质需要应用最大同时生效灯光数
        var unsubModel = context.eventBus.on('model:loaded', function() {
            applyMaxSimultaneousLights(maxSimultaneousLights);
            applyPBRCompensation();
            refreshAllShadowCasters();
        });
        unsubscribers.push(unsubModel);

        // 读取 V2 全局控制与用户预设；兼容首次安装时没有这些键的情况。
        context.storage.get('maxSimultaneousLights').then(function(saved) {
            if (typeof saved === 'number' && saved >= MAX_LIGHTS_MIN && saved <= MAX_LIGHTS_MAX) {
                maxSimultaneousLights = Math.min(PLUGIN_LIGHT_LIMIT, Math.max(MAX_LIGHTS_MIN, Math.floor(saved)));

                if (maxLightsSlider) { try { maxLightsSlider.setValue(saved); } catch (e) {} }
            }
            return context.storage.get('globalLightEnabled');
        }).then(function(savedEnabled) {
            if (typeof savedEnabled === 'boolean') globalLightEnabled = savedEnabled;
            return context.storage.get('globalMeshVisible');
        }).then(function(savedMeshVisible) {
            if (typeof savedMeshVisible === 'boolean') globalMeshVisible = savedMeshVisible;
            return context.storage.get('globalIntensityMultiplier');
        }).then(function(savedMult) {
            if (typeof savedMult === 'number' && savedMult >= 0 && savedMult <= 3) globalIntensityMultiplier = savedMult;
            return context.storage.get('pbrCompensationEnabled');
        }).then(function(savedPbr) {
            if (typeof savedPbr === 'boolean') pbrCompensationEnabled = savedPbr;
            return context.storage.get('userLightPresets');
        }).then(function(savedPresets) {
            if (Array.isArray(savedPresets)) {
                // 严格清理旧版超过8盏灯的用户预设，避免历史数据绕过本版硬限制。
                var validPresets = savedPresets.filter(function(p) {
                    return p && Array.isArray(p.lights) && p.lights.length <= USER_PRESET_LIGHT_MAX;
                });
                userLightPresets = validPresets.slice(-USER_PRESET_MAX);
                if (validPresets.length !== savedPresets.length || userLightPresets.length !== savedPresets.length) {
                    context.storage.set('userLightPresets', userLightPresets);
                }
            }
            refreshUserPresetDropdown();
            applyGlobalIntensityMultiplier();
            applyGlobalLightEnabled();
            applyGlobalMeshVisible();
            applyMaxSimultaneousLights(maxSimultaneousLights);
            applyPBRCompensation();
        }).catch(function(e) {
            console.warn('[LightManager] V2 设置读取失败:', e);
            applyGlobalIntensityMultiplier(); applyGlobalLightEnabled(); applyMaxSimultaneousLights(maxSimultaneousLights); applyPBRCompensation();
        });

        return container;
    };

    /**
     * 创建"灯光生效设置"区域
     */
    function createSettingsSection() {
        var section = document.createElement('div');
        section.className = 'v2-global-section';
        section.style.cssText = 'background: var(--color-surface); border-radius: var(--radius-md); padding: 12px; border: 1px solid var(--color-border);';

        var title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--text-primary);';
        title.textContent = '全局控制';
        section.appendChild(title);

        var master = new mp.ui.ToggleSwitch({ label: '灯光总开关', initialState: globalLightEnabled });
        master.onChange(function(enabled) {
            globalLightEnabled = !!enabled;
            applyGlobalLightEnabled();
            if (pluginContext) pluginContext.storage.set('globalLightEnabled', globalLightEnabled);
        });
        section.appendChild(master.element);

        var meshMaster = new mp.ui.ToggleSwitch({ label: '隐藏灯光网格', initialState: !globalMeshVisible });
        meshMaster.onChange(function(hidden) {
            globalMeshVisible = !hidden;
            applyGlobalMeshVisible();
            if (pluginContext) pluginContext.storage.set('globalMeshVisible', globalMeshVisible);
        });
        section.appendChild(meshMaster.element);

        var mult = new Slider({
            label: '全局灯光强度倍率', min: 0, max: 3, step: 0.01,
            value: globalIntensityMultiplier, showValue: true
        });
        mult.onChange(function(value) {
            globalIntensityMultiplier = Math.max(0, Number(value) || 0);
            applyGlobalIntensityMultiplier();
            if (pluginContext) pluginContext.storage.set('globalIntensityMultiplier', globalIntensityMultiplier);
        });
        section.appendChild(mult.element);

        var pbr = new mp.ui.ToggleSwitch({ label: 'PBR材质识别 / 灯光补偿', initialState: pbrCompensationEnabled });
        pbr.onChange(function(enabled) {
            pbrCompensationEnabled = !!enabled;
            applyPBRCompensation();
            if (pluginContext) pluginContext.storage.set('pbrCompensationEnabled', pbrCompensationEnabled);
        });
        section.appendChild(pbr.element);

        var pbrTip = document.createElement('div');
        pbrTip.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.5; margin: 4px 0 8px;';
        pbrTip.textContent = '仅对识别到的PBR材质提高直接光响应，不修改灯光本身的保存强度。';
        section.appendChild(pbrTip);

        var desc = document.createElement('div');
        desc.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5;';
        desc.textContent = '灯光管理器本身最多执行8盏灯光；数量越高，GPU压力越大。建议移动端尽量控制在较少灯光。';
        section.appendChild(desc);

        var slider = new Slider({
            label: '最大同时生效灯光数', min: MAX_LIGHTS_MIN, max: MAX_LIGHTS_MAX,
            step: 1, value: maxSimultaneousLights, showValue: true
        });
        slider.onChange(function(value) {
            maxSimultaneousLights = value;
            applyMaxSimultaneousLights(value);
            if (pluginContext) pluginContext.storage.set('maxSimultaneousLights', value);
        });
        section.appendChild(slider.element);
        maxLightsSlider = slider;

        return section;
    }

    function applyGlobalIntensityMultiplier() {
        lights.forEach(function(info) {
            if (info && info.light) info.light.intensity = (Number(info.intensity) || 0) * globalIntensityMultiplier;
        });
    }

    function applyGlobalLightEnabled() {
        lights.forEach(function(info) {
            if (!info || !info.light) return;
            info.light.setEnabled(!!info.enabled && globalLightEnabled);
            if (info.mesh) info.mesh.setEnabled(!!info.enabled && !!info.meshVisible && globalMeshVisible);
        });
    }

    function applyGlobalMeshVisible() {
        lights.forEach(function(info) {
            if (!info || !info.mesh) return;
            info.mesh.setEnabled(!!info.enabled && !!info.meshVisible && globalMeshVisible);
        });
    }

    function isPBRMaterial(mat) {
        if (!mat) return false;
        var cls = '';
        try { if (typeof mat.getClassName === 'function') cls = mat.getClassName() || ''; } catch (e) {}
        if (typeof mat.directIntensity === 'number') {
            return /PBR|PBRMetallic|PBRMaterial|PBRBase/i.test(cls) || mat.usePhysicalLightFalloff !== undefined;
        }
        return /PBR|PBRMetallic/i.test(cls);
    }

    function applyPBRCompensation() {
        if (!scene) return;
        var seen = {};
        function apply(mat) {
            if (!mat || seen[mat.uniqueId]) return;
            seen[mat.uniqueId] = true;
            if (isPBRMaterial(mat) && typeof mat.directIntensity === 'number') {
                mat.directIntensity = pbrCompensationEnabled ? PBR_DIRECT_INTENSITY : 1.0;
            }
        }
        (scene.materials || []).forEach(apply);
        (scene.meshes || []).forEach(function(mesh) {
            if (!mesh) return;
            apply(mesh.material);
            if (mesh.subMeshes) mesh.subMeshes.forEach(function(sub) { if (sub) apply(sub.material); });
        });
    }

    function getLightDirectionArray(light) {
        if (!light || !light.direction) return [0, -1, 0];
        return [Number(light.direction.x)||0, Number(light.direction.y)||-1, Number(light.direction.z)||0];
    }

    function getLightRotationArray(info) {
        if (!info || !info.mesh || !info.mesh.rotation) return [0,0,0];
        return [Number(info.mesh.rotation.x)||0, Number(info.mesh.rotation.y)||0, Number(info.mesh.rotation.z)||0];
    }

    function round3(v) { return Math.round((Number(v)||0) * 1000) / 1000; }

    function snapshotLights() {
        var arr = [];
        lights.forEach(function(info) {
            if (!info || !info.light) return;
            var p = info.light.position || {x:0,y:0,z:0};
            var c = info.color || {r:1,g:1,b:1};
            arr.push({
                type: info.type,
                position: [round3(p.x), round3(p.y), round3(p.z)],
                direction: getLightDirectionArray(info.light).map(round3),
                rotation: getLightRotationArray(info).map(round3),
                color: [round3(c.r), round3(c.g), round3(c.b)],
                intensity: round3(info.intensity),
                enabled: !!info.enabled,
                meshVisible: !!info.meshVisible,
                angle: info.type === 'spot' ? round3((info.angle || info.light.angle || Math.PI/3) * 180 / Math.PI) : 0,
                shadowEnabled: !!info.shadowEnabled,
                shadowMapSize: Number(info.shadowMapSize) || SHADOW_MAP_SIZE_DEFAULT,
                shadowBlur: !!info.shadowBlur
            });
        });
        return arr;
    }

    function makePresetName() {
        var base = '灯光预设 ' + (userLightPresets.length + 1);
        if (!userLightPresets.some(function(p){ return p.name === base; })) return base;
        var i = 2;
        while (userLightPresets.some(function(p){ return p.name === base + ' (' + i + ')' ; })) i++;
        return base + ' (' + i + ')';
    }

    function saveUserPresets() {
        if (!pluginContext) return Promise.resolve();
        return pluginContext.storage.set('userLightPresets', userLightPresets);
    }

    function refreshUserPresetDropdown() {
        if (!userPresetDropdownHost) return;
        userPresetDropdownHost.innerHTML = '';
        var options = userLightPresets.length
            ? userLightPresets.map(function(p, i){ return { value: String(i), label: p.name }; })
            : [{ value: '', label: '暂无用户偏好' }];
        userPresetDropdown = new Dropdown({
            options: options,
            selectedValue: userLightPresets.length ? String(Math.max(0, userLightPresets.length - 1)) : '',
            placeholder: '选择用户偏好'
        });
        userPresetDropdownHost.appendChild(userPresetDropdown.element);
        if (userPresetDesc) {
            var idx = userLightPresets.length ? (parseInt(userPresetDropdown.getValue(),10) || 0) : -1;
            var p = idx >= 0 ? userLightPresets[idx] : null;
            userPresetDesc.textContent = p ? ('包含 ' + p.lights.length + ' 盏灯；保存于 ' + (p.timeText || '本次会话')) : '暂无用户偏好预设。';
        }
    }

    function selectedUserPreset() {
        if (!userLightPresets.length) return null;
        var idx = 0;
        if (userPresetDropdown) {
            try { idx = parseInt(userPresetDropdown.getValue(), 10) || 0; } catch (e) {}
        }
        return userLightPresets[idx] || userLightPresets[0];
    }

    function createUserPresetSection() {
        var section = document.createElement('div');
        section.className = 'v2-user-preset-section';
        section.style.cssText = 'background: var(--color-surface); border-radius: var(--radius-md); padding: 12px; border: 1px solid var(--color-border);';

        var title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--text-primary);';
        title.textContent = '用户偏好';
        section.appendChild(title);

        var tip = document.createElement('div');
        tip.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;';
        tip.textContent = '保存当前全部灯光状态，包括位置、方向、颜色、强度、角度、显示状态和阴影设置；不会覆盖官方预设。';
        section.appendChild(tip);

        var host = document.createElement('div');
        host.className = 'v2-user-preset-dropdown-host';
        section.appendChild(host);
        userPresetDropdown = null;
        userPresetDropdownHost = host;

        var desc = document.createElement('div');
        userPresetDesc = desc;
        desc.style.cssText = 'font-size: 11px; color: var(--text-disabled); line-height: 1.5; margin: 8px 0; min-height: 18px;';
        desc.textContent = '暂无用户偏好预设。';
        section.appendChild(desc);

        var presetActionRow = document.createElement('div');
        presetActionRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:2px;';

        var renameBtn = document.createElement('button');
        renameBtn.className = 'mp-btn';
        renameBtn.textContent = '重命名预设';
        renameBtn.style.cssText = 'min-height:40px;font-size:13px;font-weight:600;';
        renameBtn.addEventListener('click', renameSelectedUserPreset);
        presetActionRow.appendChild(renameBtn);

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'mp-btn danger';
        deleteBtn.textContent = '删除选中预设';
        deleteBtn.style.cssText = 'min-height:40px;font-size:13px;font-weight:600;';
        deleteBtn.addEventListener('click', deleteSelectedUserPreset);
        presetActionRow.appendChild(deleteBtn);
        section.appendChild(presetActionRow);

        refreshUserPresetDropdown();
        return section;
    }

    function renameSelectedUserPreset() {
        var preset = selectedUserPreset();
        if (!preset || !userLightPresets.length) { toast.info('当前没有可重命名的用户预设', 1800); return; }
        var oldName = String(preset.name || '灯光预设');
        var name = window.prompt('请输入新的预设名称：', oldName);
        if (name === null) return;
        name = String(name).trim();
        if (!name) { toast.info('预设名称不能为空', 1800); return; }
        if (Array.from(name).length > 12) { toast.info('预设名称最多12个字符，请重新输入。', 2200); return; }
        if (userLightPresets.some(function(p){ return p !== preset && String(p.name || '') === name; })) {
            toast.info('已存在同名用户预设，请换一个名称。', 2000); return;
        }
        preset.name = name;
        saveUserPresets().then(function(){ refreshUserPresetDropdown(); toast.success('已重命名为：' + name, 2000); }).catch(function(){
            preset.name = oldName; refreshUserPresetDropdown(); toast.error('重命名保存失败', 2000);
        });
    }

    function deleteSelectedUserPreset() {
        var preset = selectedUserPreset();
        if (!preset || !userLightPresets.length) {
            toast.info('当前没有可删除的用户预设', 1800);
            return;
        }

        var idx = userLightPresets.indexOf(preset);
        if (idx < 0) {
            toast.error('未找到要删除的用户预设', 1800);
            return;
        }

        var name = String(preset.name || ('灯光预设 ' + (idx + 1)));
        if (!window.confirm('确定删除用户预设“' + name + '”吗？\n\n删除后无法通过灯光管理器恢复。当前场景中的灯光不会受到影响。')) return;

        userLightPresets.splice(idx, 1);
        saveUserPresets().then(function() {
            refreshUserPresetDropdown();
            toast.success('已删除用户预设：' + name, 2000);
        }).catch(function() {
            // 本地存储失败时尽量恢复内存中的数据，避免界面与持久化状态不一致。
            userLightPresets.splice(idx, 0, preset);
            refreshUserPresetDropdown();
            toast.error('删除失败，用户预设未被保存修改', 2200);
        });
    }

    function saveCurrentAsUserPreset() {
        if (lights.size > USER_PRESET_LIGHT_MAX) { toast.info('灯光过多，请进行删减优化。用户预设最多保存8盏灯光。当前：' + lights.size + ' / 8', 2600); return; }
        if (lights.size === 0) { toast.info('当前灯光列表为空，无法保存预设。', 1800); return; }
        if (userLightPresets.length >= USER_PRESET_MAX) { toast.info('用户预设已达到上限（12个），请先删除一个预设。', 2200); return; }
        var name = window.prompt('请输入用户灯光预设名称：', makePresetName());
        if (name === null) return;
        name = String(name).trim() || makePresetName();
        var preset = { name:name, lights:snapshotLights(), timeText:new Date().toLocaleString() };
        userLightPresets.push(preset);
        saveUserPresets().then(function(){ refreshUserPresetDropdown(); toast.success('已保存用户预设：' + name, 2000); }).catch(function(){ toast.error('用户预设保存失败',2200); });
    }

    // -------- MMDPLAY 改灯码 V1 --------
    // 规则：当前灯光列表完整快照 -> 紧凑位打包 -> Base64URL -> MMDPLAY_..._MMDPLAY。
    // 不依赖官方预设；导入后仅保存到“用户偏好”，不会直接修改当前场景。
    function utf8Bytes(text) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
        var s=unescape(encodeURIComponent(text)), a=new Uint8Array(s.length); for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i); return a;
    }
    function b64url(bytes) {
        var bin=''; for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    }
    function fromB64url(str) {
        str=str.replace(/-/g,'+').replace(/_/g,'/'); while(str.length%4)str+='=';
        var bin=atob(str), a=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i); return a;
    }
    function fnv16(bytes) { var h=2166136261; for(var i=0;i<bytes.length;i++){h^=bytes[i];h=Math.imul(h,16777619);} return (h>>>0).toString(16).slice(-4).padStart(4,'0'); }
    function typeCode(t){ return t==='hemispheric'?0:t==='directional'?1:t==='point'?2:3; }
    function codeType(n){ return ['hemispheric','directional','point','spot'][n] || 'spot'; }
    function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

    // 简单位流：把多个参数紧密塞入连续 bit，避免每个数都占完整 8/16/32 bit。
    function BitWriter(){this.a=[];this.cur=0;this.bits=0;}
    BitWriter.prototype.write=function(v,n){v=Math.floor(Number(v)||0); if(v<0)v=0; for(var i=n-1;i>=0;i--){this.cur=(this.cur<<1)|((v>>>i)&1);this.bits++;if(this.bits===8){this.a.push(this.cur);this.cur=0;this.bits=0;}}};
    BitWriter.prototype.finish=function(){if(this.bits){this.a.push(this.cur<<(8-this.bits));this.cur=0;this.bits=0;}return new Uint8Array(this.a);};
    function BitReader(bytes){this.a=bytes;this.i=0;this.bits=0;this.cur=0;}
    BitReader.prototype.read=function(n){var v=0;for(var k=0;k<n;k++){if(this.bits===0){if(this.i>=this.a.length)throw new Error('编码数据不完整');this.cur=this.a[this.i++];this.bits=8;}v=(v<<1)|((this.cur>>7)&1);this.cur=(this.cur<<1)&255;this.bits--;}return v;};

    function qSigned(v, min, step, bits){return clamp(Math.round(((Number(v)||0)-min)/step),0,(1<<bits)-1);}
    function dSigned(q,min,step){return q*step+min;}
    function qAngleRad(v){var pi=Math.PI, x=Number(v)||0; while(x<-pi)x+=2*pi; while(x>pi)x-=2*pi; return Math.round((x+pi)/(2*pi)*1023);}
    function dAngleRad(q){return q/1023*(2*Math.PI)-Math.PI;}

    // 方向用“方位角 + 仰角”各 8 bit 编码，稳定、直观且无需保存 3 个 float。
    function encodeDirection(x,y,z){
        x=Number(x)||0;y=Number(y)||-1;z=Number(z)||0;
        var len=Math.sqrt(x*x+y*y+z*z)||1;x/=len;y/=len;z/=len;
        var yaw=Math.atan2(z,x); // -PI ~ PI
        var elev=Math.asin(clamp(y,-1,1)); // -PI/2 ~ PI/2
        return [clamp(Math.round((yaw+Math.PI)/(2*Math.PI)*255),0,255),clamp(Math.round((elev+Math.PI/2)/Math.PI*255),0,255)];
    }
    function decodeDirection(a,b){
        var yaw=a/255*(2*Math.PI)-Math.PI, elev=b/255*Math.PI-Math.PI/2;
        var ce=Math.cos(elev);return [Math.cos(yaw)*ce,Math.sin(elev),Math.sin(yaw)*ce];
    }
    function shadowMapCode(v){return v===512?0:v===1024?1:v===2048?2:v===4096?3:1;}
    function shadowMapValue(v){return [512,1024,2048,4096][v&3]||1024;}

    function encodeCurrentLightList(){
        var ls=snapshotLights();
        if(ls.length>USER_PRESET_LIGHT_MAX)throw new Error('灯光过多，请进行删减优化。改灯码最多分享8盏灯光。');
        var w=new BitWriter();
        // 文件头：MP3 + 灯光数量。名称不编码，因为分享的是“当前灯光列表”，导入后自动命名用户预设。
        w.write(77,8);w.write(80,8);w.write(51,8);w.write(ls.length,8);
        ls.forEach(function(l){
            var tc=typeCode(l.type), flags=(l.enabled?1:0)|(l.meshVisible?2:0)|(l.shadowEnabled?4:0)|(l.shadowBlur?8:0);
            w.write(tc,2);w.write(flags,4);w.write(shadowMapCode(Number(l.shadowMapSize)||1024),2);
            var p=l.position||[0,0,0];
            // 位置：0.1 精度，-819.2~+819.1，共 42 bit。
            for(var i=0;i<3;i++)w.write(qSigned(p[i],-819.2,0.1,14),14);
            var d=encodeDirection.apply(null,l.direction||[0,-1,0]);w.write(d[0],8);w.write(d[1],8);
            var r=l.rotation||[0,0,0];for(var j=0;j<3;j++)w.write(qAngleRad(r[j]),10);
            var c=l.color||[1,1,1];for(var k=0;k<3;k++)w.write(clamp(Math.round((Number(c[k])||0)*255),0,255),8);
            var im=Number(l.intensity)||0;
            // 按灯型使用最小位宽：环境/方向 0~5.11、Spot 0~40.95、Point 0~327.67。
            var ib=tc===2?15:(tc===3?12:9);w.write(clamp(Math.round(im*100),0,(1<<ib)-1),ib);
            // Spot 角度为 1~90 度，1 度精度；其他灯不占额外角度数据。
            if(tc===3)w.write(clamp(Math.round(Number(l.angle)||60),1,90)-1,7);
        });
        var bytes=w.finish();
        return 'MMDPLAY_'+b64url(bytes)+'_'+fnv16(bytes)+'_MMDPLAY';
    }

    function decodeMMDPlayCode(code){
        code=String(code||'').trim();
        var m=code.match(/^MMDPLAY_([A-Za-z0-9_-]+)_([0-9a-fA-F]{4})_MMDPLAY$/);
        if(!m)throw new Error('不是有效的 MMDPLAY 改灯码');
        var bytes;try{bytes=fromB64url(m[1]);}catch(e){throw new Error('改灯码数据损坏');}
        if(fnv16(bytes).toLowerCase()!==m[2].toLowerCase())throw new Error('校验失败，改灯码可能已损坏');
        var r=new BitReader(bytes);if(r.read(8)!==77||r.read(8)!==80||r.read(8)!==51)throw new Error('改灯码版本不正确');
        var count=r.read(8);if(count>USER_PRESET_LIGHT_MAX)throw new Error('灯光数量超过8盏，改灯码最多支持8盏灯光');
        var ls=[];
        for(var n=0;n<count;n++){
            var tc=r.read(2),flags=r.read(4),sm=r.read(2),p=[],d=[],rot=[],col=[];
            for(var i=0;i<3;i++)p.push(dSigned(r.read(14),-819.2,0.1));
            d=decodeDirection(r.read(8),r.read(8));
            for(var j=0;j<3;j++)rot.push(dAngleRad(r.read(10)));
            for(var k=0;k<3;k++)col.push(r.read(8)/255);
            var ib=tc===2?15:(tc===3?12:9), intensity=r.read(ib)/100;
            var angle=0;if(tc===3)angle=r.read(7)+1;
            ls.push({type:codeType(tc),position:p,direction:d,rotation:rot,color:col,intensity:intensity,enabled:!!(flags&1),meshVisible:!!(flags&2),shadowEnabled:!!(flags&4),shadowBlur:!!(flags&8),shadowMapSize:shadowMapValue(sm),angle:angle});
        }
        return {name:'分享灯光',lights:ls,timeText:new Date().toLocaleString()};
    }

    function closeLM2Dialog(){var old=document.getElementById('lm2-dialog-overlay');if(old&&old.parentNode)old.parentNode.removeChild(old);}
    function createLM2Dialog(titleText,bodyText,initialValue,buttons){
        closeLM2Dialog();var overlay=document.createElement('div');overlay.id='lm2-dialog-overlay';overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;';
        var box=document.createElement('div');box.style.cssText='width:min(92vw,520px);max-height:86vh;overflow:auto;background:var(--color-surface,#fff);color:var(--text-primary,#222);border:1px solid var(--color-border,#ddd);border-radius:14px;padding:16px;box-sizing:border-box;box-shadow:0 12px 40px rgba(0,0,0,.25);';overlay.appendChild(box);
        var title=document.createElement('div');title.textContent=titleText;title.style.cssText='font-size:16px;font-weight:700;margin-bottom:8px;';box.appendChild(title);
        var body=document.createElement('div');body.textContent=bodyText;body.style.cssText='font-size:12px;line-height:1.5;color:var(--text-secondary,#666);margin-bottom:10px;';box.appendChild(body);
        var area=document.createElement('textarea');area.value=initialValue||'';area.style.cssText='width:100%;min-height:150px;max-height:45vh;box-sizing:border-box;padding:10px;border:1px solid var(--color-border,#ccc);border-radius:9px;background:var(--color-bg,#fafafa);color:var(--text-primary,#222);font-size:12px;line-height:1.45;resize:vertical;';box.appendChild(area);
        var row=document.createElement('div');row.style.cssText='display:flex;gap:8px;margin-top:12px;justify-content:flex-end;';buttons.forEach(function(def){var b=document.createElement('button');b.className='mp-btn'+(def.primary?' primary':'');b.textContent=def.label;b.style.cssText='min-height:40px;padding:8px 14px;';b.addEventListener('click',function(){def.onClick(area,overlay);});row.appendChild(b);});box.appendChild(row);document.body.appendChild(overlay);setTimeout(function(){try{area.focus();area.select();}catch(e){}},0);return{overlay:overlay,area:area};
    }
    function copyTextCompat(text,done){text=String(text||'');if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){navigator.clipboard.writeText(text).then(done).catch(function(){fallbackCopyText(text,done);});}else fallbackCopyText(text,done);}
    function fallbackCopyText(text,done){var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;left:-9999px;top:-9999px;opacity:0;';document.body.appendChild(ta);ta.focus();ta.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);if(ok)done();else toast.info('请长按改灯码文本并手动复制',2600);}

    function makeImportedPresetName(){var base='分享灯光';if(!userLightPresets.some(function(p){return p.name===base;}))return base;var i=2;while(userLightPresets.some(function(p){return p.name===base+' '+i;}))i++;return base+' '+i;}
    function shareUserPreset(){
        if(!lights||lights.size===0){toast.info('当前灯光列表为空，无法生成改灯码',1800);return;}
        if(lights.size>USER_PRESET_LIGHT_MAX){toast.info('灯光过多，请进行删减优化。改灯码最多分享8盏灯光。当前：'+lights.size+' / 8',2600);return;}
        var code;try{code=encodeCurrentLightList();}catch(e){toast.error('改灯码生成失败：'+(e&&e.message?e.message:'未知错误'),2600);return;}
        createLM2Dialog('分享 MMDPLAY 改灯码','已提取当前灯光列表的完整参数。复制下面的改灯码，可在另一台设备导入。',code,[{label:'关闭',onClick:function(){closeLM2Dialog();}},{label:'复制改灯码',primary:true,onClick:function(area){copyTextCompat(area.value,function(){toast.success('改灯码已复制',1800);});}}]);
    }
    function importUserPreset(){
        createLM2Dialog('导入 MMDPLAY 改灯码','粘贴分享的 MMDPLAY 改灯码。导入后只新增到“用户偏好”，不会改变当前灯光列表。',[].join(''),[{label:'取消',onClick:function(){closeLM2Dialog();}},{label:'导入',primary:true,onClick:function(area){var code=String(area.value||'').trim();if(!code){toast.info('请先粘贴 MMDPLAY 改灯码',1800);return;}if(userLightPresets.length>=USER_PRESET_MAX){toast.info('用户预设已达到上限（12个），请先删除一个预设。',2200);return;}try{var p=decodeMMDPlayCode(code);if(!p.lights||p.lights.length>USER_PRESET_LIGHT_MAX)throw new Error('灯光数量超过8盏，无法导入');var name=makeImportedPresetName();p.name=name;userLightPresets.push(p);saveUserPresets().then(function(){refreshUserPresetDropdown();closeLM2Dialog();toast.success('已导入“'+name+'”，当前灯光未改变',2200);}).catch(function(){userLightPresets.pop();toast.error('导入后保存失败',2200);});}catch(e){toast.error('导入失败：'+(e&&e.message?e.message:'改灯码无效'),2600);}}}]);
    }

    function canFitLights(addCount) {
        var need = Math.max(0, Number(addCount) || 0);
        return lights.size + need <= PLUGIN_LIGHT_LIMIT;
    }

    function restoreLightSnapshot(snapshot, replaceCurrent) {
        if(!scene||!Array.isArray(snapshot))return;
        if(snapshot.length > USER_PRESET_LIGHT_MAX) { toast.info('灯光过多，请进行删减优化。该用户预设超过8盏灯光，无法执行。', 2600); return; }
        if(!replaceCurrent && !canFitLights(snapshot.length)) { toast.info('灯光过多，请进行删减优化。追加后最多允许8盏灯光。', 2600); return; }
        if(replaceCurrent)clearAllLights();
        var restored=0;
        snapshot.forEach(function(cfg){
            var before=lightCounter; createLight(cfg.type,cfg.position||[0,0,0],{r:(cfg.color||[1,1,1])[0],g:(cfg.color||[1,1,1])[1],b:(cfg.color||[1,1,1])[2]},Number(cfg.intensity)||0);
            var info=null; lights.forEach(function(v){if(!info&&v&&v.id&&v.name&&v.name.endsWith(' '+lightCounter))info=v;}); if(!info||lightCounter<=before)return;
            // 完整恢复灯光属性：创建灯光后再次显式写回强度、颜色、方向和启用状态，避免宿主/全局倍率导致恢复后
            // 灯光对象存在但实际照明强度为 0。保存的是用户原始强度，实际 Babylon 强度统一由全局倍率计算。
            if (info.light) {
                var restoreColor = cfg.color || [1,1,1];
                info.color = {r:Number(restoreColor[0])||0,g:Number(restoreColor[1])||0,b:Number(restoreColor[2])||0};
                info.light.diffuse = new BABYLON.Color3(info.color.r, info.color.g, info.color.b);
                info.intensity = Math.max(0, Number(cfg.intensity) || 0);
                info.light.intensity = info.intensity * globalIntensityMultiplier;
                if (info.light.specular) info.light.specular = new BABYLON.Color3(1,1,1);
            }
            if(info.type==='spot'){
                updateLightAngle(info, Number(cfg.angle) || 60);
                try {
                    if (typeof BABYLON.Light !== 'undefined' && typeof BABYLON.Light.FALLOFF_STANDARD === 'number') {
                        info.light.falloffType = BABYLON.Light.FALLOFF_STANDARD;
                        info.light.range = 1000;
                    }
                } catch(e) {}
            }
            if(info.light.direction&&cfg.direction)info.light.direction=new BABYLON.Vector3(cfg.direction[0],cfg.direction[1],cfg.direction[2]);
            if(info.mesh&&cfg.rotation){info.mesh.rotation.x=cfg.rotation[0]||0;info.mesh.rotation.y=cfg.rotation[1]||0;info.mesh.rotation.z=cfg.rotation[2]||0;updateLightTransformFromMesh(info,info.mesh); if(cfg.direction)info.light.direction=new BABYLON.Vector3(cfg.direction[0],cfg.direction[1],cfg.direction[2]);}
            info.enabled=cfg.enabled!==false; info.meshVisible=cfg.meshVisible!==false; info.shadowMapSize=cfg.shadowMapSize||SHADOW_MAP_SIZE_DEFAULT; info.shadowBlur=!!cfg.shadowBlur;
            if(cfg.shadowEnabled&&hasShadowSupport(info))setShadowEnabled(info,true);
            // 阴影创建/变换更新后再写一次强度，确保 ShadowGenerator 或宿主实现没有覆盖 intensity。
            if(info.light){ info.light.intensity = info.intensity * globalIntensityMultiplier; info.light.setEnabled(info.enabled&&globalLightEnabled); }
            if(info.mesh)info.mesh.setEnabled(info.enabled&&info.meshVisible);
            if(info.toggleBtn){info.toggleBtn.textContent=info.enabled?'隐藏':'显示';info.uiElement.style.opacity=info.enabled?'1':'0.5';}
            restored++;
        });
        applyGlobalIntensityMultiplier();applyMaxSimultaneousLights(maxSimultaneousLights);applyPBRCompensation();toast.success('已恢复 '+restored+' 盏灯光',2200);
    }

    /**
     * 将"最大同时生效灯光数"应用到场景中的所有材质
     * @param {number} count - 最大同时生效灯光数
     * @returns {number} 已应用的材质数量
     */
    function applyMaxSimultaneousLights(count) {
        if (!scene) return 0;

        var applied = 0;
        var seen = {};

        function applyToMaterial(mat) {
            if (!mat || seen[mat.uniqueId]) return;
            seen[mat.uniqueId] = true;
            if (typeof mat.maxSimultaneousLights === 'number') {
                mat.maxSimultaneousLights = count;
                applied++;
            }
        }

        // 遍历场景中的全部材质
        var materials = scene.materials || [];
        for (var i = 0; i < materials.length; i++) {
            applyToMaterial(materials[i]);
        }

        // 兜底：遍历网格及其子网格，处理未出现在 scene.materials 中的材质
        var meshes = scene.meshes || [];
        for (var j = 0; j < meshes.length; j++) {
            var mesh = meshes[j];
            if (!mesh) continue;
            applyToMaterial(mesh.material);
            if (mesh.subMeshes) {
                for (var s = 0; s < mesh.subMeshes.length; s++) {
                    var sub = mesh.subMeshes[s];
                    if (sub) applyToMaterial(sub.material);
                }
            }
        }

        return applied;
    }

    /**
     * 创建灯光组合预设区域
     */
    function createPresetSection() {
        var section = document.createElement('div');
        section.style.cssText = 'background: var(--color-surface); border-radius: var(--radius-md); padding: 12px; border: 1px solid var(--color-border);';

        var title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--text-primary);';
        title.textContent = '灯光组合预设';
        section.appendChild(title);

        var tip = document.createElement('div');
        tip.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;';
        tip.textContent = '仅使用聚光灯；灯位按45°空间方向布置，高位约50–70，部分预设采用低位或高低错落；每组总亮度≤0.75。';
        section.appendChild(tip);

        var dropdown = new Dropdown({
            options: LIGHT_PRESETS.map(function(p) { return { value: p.value, label: p.label }; }),
            selectedValue: LIGHT_PRESETS[0].value,
            placeholder: '选择灯光预设'
        });
        section.appendChild(dropdown.element);

        var desc = document.createElement('div');
        desc.style.cssText = 'font-size: 11px; color: var(--text-disabled); line-height: 1.5; margin: 8px 0; min-height: 32px;';
        section.appendChild(desc);

        function refreshDesc() {
            var value = dropdown.getValue();
            var preset = LIGHT_PRESETS.find(function(p) { return p.value === value; });
            desc.textContent = preset ? preset.description : '';
        }
        if (dropdown.onChange) dropdown.onChange(refreshDesc);
        refreshDesc();

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 8px;';

        var replaceBtn = document.createElement('button');
        replaceBtn.className = 'mp-btn primary';
        replaceBtn.style.cssText = 'flex: 1;';
        replaceBtn.textContent = '替换';
        replaceBtn.addEventListener('click', function() {
            applyLightPreset(dropdown.getValue(), true);
        });
        btnRow.appendChild(replaceBtn);

        var clearBtn = document.createElement('button');
        clearBtn.className = 'mp-btn';
        clearBtn.style.cssText = 'flex: 1;';
        clearBtn.textContent = '清空';
        clearBtn.addEventListener('click', function() {
            clearAllLights();
            toast.success('已清空所有灯光', 1800);
        });
        btnRow.appendChild(clearBtn);

        var appendBtn = document.createElement('button');
        appendBtn.className = 'mp-btn';
        appendBtn.style.cssText = 'flex: 1;';
        appendBtn.textContent = '追加';
        appendBtn.addEventListener('click', function() {
            applyLightPreset(dropdown.getValue(), false);
        });
        btnRow.appendChild(appendBtn);

        section.appendChild(btnRow);

        // 氛围灯区域：独立于基础白光预设，方便“基础布光 + 彩色氛围”叠加。
        var atmosphereWrap = document.createElement('div');
        atmosphereWrap.style.cssText = 'margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--color-border);';

        var atTitle = document.createElement('div');
        atTitle.style.cssText = 'font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text-primary);';
        atTitle.textContent = '氛围灯效果';
        atmosphereWrap.appendChild(atTitle);

        var atTip = document.createElement('div');
        atTip.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 8px;';
        atTip.textContent = '高饱和彩色聚光灯；作为白光基础布光的第二层，默认不启用阴影；每组总亮度≤1。';
        atmosphereWrap.appendChild(atTip);

        var atDropdown = new Dropdown({
            options: ATMOSPHERE_PRESETS.map(function(p) { return { value: p.value, label: p.label }; }),
            selectedValue: ATMOSPHERE_PRESETS[0].value,
            placeholder: '选择氛围灯效果'
        });
        atmosphereWrap.appendChild(atDropdown.element);

        var atDesc = document.createElement('div');
        atDesc.style.cssText = 'font-size: 11px; color: var(--text-disabled); line-height: 1.5; margin: 8px 0; min-height: 32px;';
        atmosphereWrap.appendChild(atDesc);
        function refreshAtmosphereDesc() {
            var v = atDropdown.getValue();
            var p = ATMOSPHERE_PRESETS.find(function(x) { return x.value === v; });
            atDesc.textContent = p ? p.description : '';
        }
        if (atDropdown.onChange) atDropdown.onChange(refreshAtmosphereDesc);
        refreshAtmosphereDesc();

        var atBtnRow = document.createElement('div');
        atBtnRow.style.cssText = 'display: flex; gap: 8px;';
        [['替换', true], ['清空', 'clear'], ['追加', false]].forEach(function(def) {
            var b = document.createElement('button');
            b.className = def[0] === '替换' ? 'mp-btn primary' : 'mp-btn';
            b.style.cssText = 'flex: 1;';
            b.textContent = def[0];
            b.addEventListener('click', function() {
                if (def[1] === 'clear') {
                    clearAllLights();
                    toast.success('已清空所有灯光', 1800);
                } else {
                    applyAtmospherePreset(atDropdown.getValue(), def[1]);
                }
            });
            atBtnRow.appendChild(b);
        });
        atmosphereWrap.appendChild(atBtnRow);
        section.appendChild(atmosphereWrap);

        return section;
    }

    /**
     * 应用一个多灯组合预设
     */
    function applyLightPreset(value, replaceCurrent) {
        var preset = LIGHT_PRESETS.find(function(p) { return p.value === value; });
        if (!preset || !scene) return;
        if (preset.lights.length > PLUGIN_LIGHT_LIMIT) { toast.info('灯光过多，请进行删减优化。该官方预设超过8盏灯光。', 2400); return; }
        if (!replaceCurrent && !canFitLights(preset.lights.length)) { toast.info('灯光过多，请进行删减优化。追加后最多允许8盏灯光。', 2400); return; }

        if (replaceCurrent) clearAllLights();

        var created = [];
        for (var i = 0; i < preset.lights.length; i++) {
            var cfg = preset.lights[i];
            var before = lightCounter;
            createLight(cfg.type, cfg.pos || [0,0,0], cfg.color || {r:1,g:1,b:1}, cfg.intensity);

            // createLight 同步写入 Map，取刚创建的最后一盏灯
            var info = null;
            lights.forEach(function(v) { if (v && v.id && v.name && !info && v.id.indexOf('light_') === 0 && v.name.endsWith(' ' + lightCounter)) info = v; });
            if (!info || lightCounter <= before) continue;

            if (cfg.angle && info.type === 'spot') updateLightAngle(info, cfg.angle);

            if (cfg.target && info.type === 'spot') {
                var p = info.light.position;
                var t = cfg.target;
                var dir = new BABYLON.Vector3(t[0] - p.x, t[1] - p.y, t[2] - p.z);
                if (dir.length() > 0.0001) {
                    dir.normalize();
                    info.light.direction = dir;
                }
            } else if (cfg.direction && info.light.direction) {
                info.light.direction = new BABYLON.Vector3(cfg.direction[0], cfg.direction[1], cfg.direction[2]);
            }

            if (cfg.shadow && hasShadowSupport(info)) {
                info.shadowMapSize = 1024;
                info.shadowBlur = false;
                setShadowEnabled(info, true);
            }
            created.push(info);
        }

        applyMaxSimultaneousLights(maxSimultaneousLights);
        updateLightCount();
        toast.success('已应用预设：' + preset.label + '（' + created.length + ' 盏灯）', 2200);
    }

    /**
     * 应用彩色氛围灯预设。氛围灯默认关闭阴影，避免彩色辅助光造成额外阴影开销与画面脏乱。
     */
    function applyAtmospherePreset(value, replaceCurrent) {
        var preset = ATMOSPHERE_PRESETS.find(function(p) { return p.value === value; });
        if (!preset || !scene) return;
        if (preset.lights.length > PLUGIN_LIGHT_LIMIT) { toast.info('灯光过多，请进行删减优化。该氛围预设超过8盏灯光。', 2400); return; }
        if (!replaceCurrent && !canFitLights(preset.lights.length)) { toast.info('灯光过多，请进行删减优化。追加后最多允许8盏灯光。', 2400); return; }
        if (replaceCurrent) clearAllLights();

        var created = [];
        for (var i = 0; i < preset.lights.length; i++) {
            var cfg = preset.lights[i];
            var before = lightCounter;
            createLight(cfg.type, cfg.pos || [0,0,0], cfg.color || {r:1,g:1,b:1}, cfg.intensity);
            var info = null;
            lights.forEach(function(v) { if (v && v.id && v.name && !info && v.id.indexOf('light_') === 0 && v.name.endsWith(' ' + lightCounter)) info = v; });
            if (!info || lightCounter <= before) continue;
            if (cfg.angle && info.type === 'spot') updateLightAngle(info, cfg.angle);
            if (cfg.target && info.type === 'spot') {
                var p = info.light.position, t = cfg.target;
                var dir = new BABYLON.Vector3(t[0] - p.x, t[1] - p.y, t[2] - p.z);
                if (dir.length() > 0.0001) { dir.normalize(); info.light.direction = dir; }
            }
            if (cfg.shadow && hasShadowSupport(info)) setShadowEnabled(info, true);
            created.push(info);
        }
        applyMaxSimultaneousLights(maxSimultaneousLights);
        updateLightCount();
        toast.success('已应用氛围灯：' + preset.label + '（' + created.length + ' 盏灯）', 2200);
    }

    function createV2OperationSection() {
        var section=document.createElement('div');
        section.style.cssText='background:var(--color-surface);border-radius:var(--radius-md);padding:12px;border:1px solid var(--color-border);';
        var title=document.createElement('div'); title.style.cssText='font-size:14px;font-weight:600;margin-bottom:10px;color:var(--text-primary);'; title.textContent='操作'; section.appendChild(title);
        var grid=document.createElement('div'); grid.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:8px;';
        function btn(text,fn,cls){var b=document.createElement('button');b.className='mp-btn'+(cls?' '+cls:'');b.style.cssText='min-height:42px;font-size:13px;';b.textContent=text;b.addEventListener('click',fn);grid.appendChild(b);}
        btn('替换',function(){
            var p=selectedUserPreset(); if(p)restoreLightSnapshot(p.lights,true); else toast.info('请先在用户偏好中选择预设',1800);
        },'primary');
        btn('保存',saveCurrentAsUserPreset);
        btn('追加',function(){
            var p=selectedUserPreset(); if(p)restoreLightSnapshot(p.lights,false); else toast.info('请先在用户偏好中选择预设',1800);
        });
        btn('导入',importUserPreset);
        btn('清空',function(){clearAllLights();toast.success('已清空所有灯光',1800);},'danger');
        btn('分享',shareUserPreset);
        section.appendChild(grid); return section;
    }

    /**
     * 创建"新建灯光"区域
     */
    function createCreateLightSection() {
        var section = document.createElement('div');
        section.style.cssText = 'background: var(--color-surface); border-radius: var(--radius-md); padding: 12px; border: 1px solid var(--color-border);';

        var title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--text-primary);';
        title.textContent = '创建新灯光';
        section.appendChild(title);

        // 灯光类型选择
        var typeRow = document.createElement('div');
        typeRow.style.cssText = 'margin-bottom: 12px;';

        var typeLabel = document.createElement('div');
        typeLabel.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;';
        typeLabel.textContent = '灯光类型';
        typeRow.appendChild(typeLabel);

        var typeDropdown = new Dropdown({
            options: LIGHT_TYPES,
            selectedValue: 'hemispheric',
            placeholder: '选择灯光类型'
        });
        typeRow.appendChild(typeDropdown.element);
        section.appendChild(typeRow);

        // 初始位置输入
        var posRow = document.createElement('div');
        posRow.style.cssText = 'margin-bottom: 12px;';

        var posLabel = document.createElement('div');
        posLabel.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;';
        posLabel.textContent = '初始位置';
        posRow.appendChild(posLabel);

        var posInput = new VectorInput({
            label: '',
            components: [
                { name: 'X', value: 0, min: -100, max: 100, step: 0.1 },
                { name: 'Y', value: 10, min: -100, max: 100, step: 0.1 },
                { name: 'Z', value: 0, min: -100, max: 100, step: 0.1 }
            ]
        });
        posRow.appendChild(posInput.element);
        section.appendChild(posRow);

        // 初始颜色
        var colorRow = document.createElement('div');
        colorRow.style.cssText = 'margin-bottom: 12px;';

        var colorPicker = new RGBColorPicker({
            label: '初始颜色',
            color: { r: 1, g: 1, b: 1 },
            mode: 'popup'
        });
        colorRow.appendChild(colorPicker.element);
        var initialQuickBtn = document.createElement('button');
        initialQuickBtn.className = 'mp-btn small';
        initialQuickBtn.textContent = '🎨 快速选色';
        initialQuickBtn.style.cssText = 'margin-top: 6px; width: 100%; padding: 6px 8px; font-size: 11px;';
        initialQuickBtn.addEventListener('click', function() {
            openQuickColorPicker(null, colorPicker);
        });
        colorRow.appendChild(initialQuickBtn);
        section.appendChild(colorRow);

        // 初始强度
        var intensityRow = document.createElement('div');
        intensityRow.style.cssText = 'margin-bottom: 12px;';

        var intensitySlider = new Slider({
            label: '初始强度',
            min: 0,
            max: 2,
            step: 0.01,
            value: 1,
            showValue: true
        });
        intensityRow.appendChild(intensitySlider.element);
        section.appendChild(intensityRow);

        // 创建按钮
        var createBtn = document.createElement('button');
        createBtn.className = 'mp-btn primary';
        createBtn.style.cssText = 'width: 100%; margin-top: 8px;';
        createBtn.textContent = '创建灯光';
        createBtn.addEventListener('click', function() {
            var type = typeDropdown.getValue();
            var pos = posInput.getValue();
            var color = colorPicker.__quickColor || colorPicker.getValue();
            var intensity = intensitySlider.getValue();

            createLight(type, pos, color, intensity);
        });
        section.appendChild(createBtn);

        return section;
    }

    /**
     * 创建灯光列表区域
     */
    function createLightListSection() {
        var section = document.createElement('div');
        section.className = 'light-list-section';
        section.style.cssText = 'background: var(--color-surface); border-radius: var(--radius-md); padding: 12px; border: 1px solid var(--color-border);';

        var title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--text-primary); display: flex; justify-content: space-between; align-items: center;';
        title.innerHTML = '<span>灯光列表</span><span class="light-count" style="font-size: 12px; color: var(--text-secondary);">(0)</span>';
        section.appendChild(title);

        var listContainer = document.createElement('div');
        listContainer.className = 'light-list-container';
        listContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto;';
        section.appendChild(listContainer);

        // 保存引用以便更新
        section.listContainer = listContainer;
        section.titleCount = title.querySelector('.light-count');

        return section;
    }

    /**
     * 初始化Gizmo管理器
     */
    function initGizmoManager() {
        if (!scene) return;

        // 创建Gizmo管理器
        gizmoManager = new BABYLON.GizmoManager(scene);
        gizmoManager.positionGizmoEnabled = true;
        gizmoManager.rotationGizmoEnabled = true;
        gizmoManager.scaleGizmoEnabled = false;
        gizmoManager.usePointerToAttachGizmos = false;

        // 监听Gizmo位置变化
        gizmoManager.onAttachedToMeshObservable.add(function(mesh) {
            if (mesh && mesh.lightRef) {
                updateLightTransformFromMesh(mesh.lightRef, mesh);
            }
        });

        // 监听位置Gizmo拖拽结束
        if (gizmoManager.gizmos.positionGizmo) {
            gizmoManager.gizmos.positionGizmo.onDragEndObservable.add(function() {
                var mesh = gizmoManager.attachedMesh;
                if (mesh && mesh.lightRef) {
                    updateLightTransformFromMesh(mesh.lightRef, mesh);
                    updateLightUI(mesh.lightRef.id);
                }
            });
        }

        // 监听旋转Gizmo拖拽结束
        if (gizmoManager.gizmos.rotationGizmo) {
            gizmoManager.gizmos.rotationGizmo.onDragEndObservable.add(function() {
                var mesh = gizmoManager.attachedMesh;
                if (mesh && mesh.lightRef) {
                    updateLightTransformFromMesh(mesh.lightRef, mesh);
                }
            });
        }
    }

    /**
     * 创建灯光
     */
    function createLight(type, position, color, intensity) {
        if (!scene) return null;
        if (lights.size >= PLUGIN_LIGHT_LIMIT) {
            toast.info('灯光过多，请进行删减优化。灯光管理器最多执行8盏灯光。', 2400);
            return null;
        }

        lightCounter++;
        var lightId = 'light_' + Date.now() + '_' + lightCounter;
        var lightName = getLightTypeLabel(type) + ' ' + lightCounter;

        var light = null;
        var mesh = null;
        var pos = new BABYLON.Vector3(position[0], position[1], position[2]);
        var col = new BABYLON.Color3(color.r, color.g, color.b);

        switch (type) {
            case 'hemispheric':
                light = new BABYLON.HemisphericLight(lightId, new BABYLON.Vector3(0, 1, 0), scene);
                light.groundColor = new BABYLON.Color3(0.2, 0.2, 0.2);
                break;
            case 'directional':
                light = new BABYLON.DirectionalLight(lightId, new BABYLON.Vector3(0, -1, 0), scene);
                light.position = pos;
                // 创建可视化网格
                mesh = createLightMesh('directional', pos, col, lightId);
                break;
            case 'point':
                light = new BABYLON.PointLight(lightId, pos, scene);
                // 创建可视化网格
                mesh = createLightMesh('point', pos, col, lightId);
                break;
            case 'spot':
                light = new BABYLON.SpotLight(lightId, pos, new BABYLON.Vector3(0, -1, 0), Math.PI / 3, 2, scene);
                // 创建可视化网格
                mesh = createLightMesh('spot', pos, col, lightId);
                break;
        }

        if (light) {
            light.diffuse = col;
            light.intensity = intensity * globalIntensityMultiplier;
            light.specular = new BABYLON.Color3(1, 1, 1);

            // 聚光灯修复（软件更新后失效）：
            // 新版宿主 Babylon 中 PBR 材质默认使用物理衰减（距离平方反比 + 高聚 SG 锥形），
            // 在 MMD 常见场景尺度下聚光灯几乎完全不可见（点光源也因此极暗）。
            // 将聚光灯显式切回标准衰减：距离衰减 1-d/range（线性）+ 经典 pow(cos, exponent) 锥形，
            // 恢复旧版软件的可见效果；方向光/环境光不受衰减影响，保持原样。
            if (type === 'spot') {
                try {
                    if (typeof BABYLON.Light !== 'undefined' && typeof BABYLON.Light.FALLOFF_STANDARD === 'number') {
                        light.falloffType = BABYLON.Light.FALLOFF_STANDARD;
                        // 标准衰减为 1 - d/range，显式设置足够大的照射范围，避免默认极端值带来的精度问题
                        light.range = 1000;
                    }
                } catch (e) {
                    console.warn('[LightManager] 设置聚光灯标准衰减失败，保持默认:', e);
                }
            }

            // 保存灯光信息
            var lightInfo = {
                id: lightId,
                name: lightName,
                type: type,
                light: light,
                mesh: mesh,
                color: color,
                intensity: intensity,
                angle: (type === 'spot') ? light.angle : undefined, // 聚光灯半角（弧度），供"光照角度"滑条使用
                enabled: true,
                meshVisible: true,  // 可视化网格显示状态
                shadowEnabled: false,        // 阴影发生器是否启用
                shadowMapSize: SHADOW_MAP_SIZE_DEFAULT, // 阴影贴图大小
                shadowBlur: false,           // 是否使用模糊阴影（PCF）
                shadowGenerator: null,       // BABYLON.ShadowGenerator 实例
                shadowToggle: null,          // 阴影开关 UI 引用
                shadowAdvanced: null,        // 阴影高级设置容器引用
                uiElement: null
            };

            if (mesh) {
                mesh.lightRef = lightInfo;
            }

            lights.set(lightId, lightInfo);
            addLightToUI(lightInfo);
            updateLightCount();

            // 确保场景中所有材质都能同时受足够多的灯光影响
            applyMaxSimultaneousLights(maxSimultaneousLights);

            toast.success('灯光 "' + lightName + '" 已创建', 2000);
        }
    }

    /**
     * 创建灯光可视化网格
     */
    function createLightMesh(type, position, color, lightId) {
        var mesh = null;
        var mat = new BABYLON.StandardMaterial(lightId + '_mat', scene);
        mat.emissiveColor = new BABYLON.Color3(color.r, color.g, color.b);
        mat.disableLighting = true;
        mat.wireframe = true;

        if (type === 'point') {
            mesh = BABYLON.MeshBuilder.CreateSphere(lightId + '_mesh', { diameter: 0.5 }, scene);
        } else if (type === 'spot') {
            // 聚光灯：增大尺寸并改为线框显示（小口朝上、大口朝下，视觉上呈向下照射的光锥）
            // 注意：不能翻转 rotation.x（旧版为 Math.PI）。网格旋转会被 updateLightTransformFromMesh
            // 用于反推灯光方向，翻转会导致 Gizmo 拖拽后聚光灯方向变成朝上、完全照不到模型。
            mesh = BABYLON.MeshBuilder.CreateCylinder(lightId + '_mesh', { diameterTop: 0.3, diameterBottom: 6, height: 9, tessellation: 32 }, scene);
        } else if (type === 'directional') {
            // 方向光：使用线框圆柱体表示
            mesh = BABYLON.MeshBuilder.CreateCylinder(lightId + '_mesh', { diameterTop: 5, diameterBottom: 5, height: 15, tessellation: 16 }, scene);
            mesh.rotation.x = Math.PI / 2;
        }

        if (mesh) {
            mesh.position = position;
            mesh.material = mat;
            mesh.isPickable = true;
        }

        return mesh;
    }

    /**
     * 更新灯光变换（位置和旋转）
     */
    function updateLightTransformFromMesh(lightInfo, mesh) {
        if (!lightInfo || !mesh) return;

        var pos = mesh.position;
        var rot = mesh.rotation;

        switch (lightInfo.type) {
            case 'directional':
                lightInfo.light.position = pos.clone();
                // 方向光：根据旋转更新方向
                var direction = new BABYLON.Vector3(0, -1, 0);
                direction.rotateByQuaternionToRef(BABYLON.Quaternion.FromEulerAngles(rot.x, rot.y, rot.z), direction);
                lightInfo.light.direction = direction;
                break;
            case 'point':
                lightInfo.light.position = pos.clone();
                break;
            case 'spot':
                lightInfo.light.position = pos.clone();
                // 聚光灯：根据旋转更新方向
                var spotDirection = new BABYLON.Vector3(0, -1, 0);
                spotDirection.rotateByQuaternionToRef(BABYLON.Quaternion.FromEulerAngles(rot.x, rot.y, rot.z), spotDirection);
                lightInfo.light.direction = spotDirection;
                break;
        }
    }

    /**
     * 添加灯光到UI
     */
    function addLightToUI(lightInfo) {
        var listSection = container.querySelector('.light-list-section');
        if (!listSection) return;

        var listContainer = listSection.listContainer;

        var item = document.createElement('div');
        item.className = 'light-item';
        item.dataset.lightId = lightInfo.id;
        item.style.cssText = 'background: var(--color-bg); border-radius: var(--radius-sm); padding: 12px; border: 1px solid var(--color-border);';

        // 头部：名称和操作按钮
        var header = document.createElement('div');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;';

        var nameLabel = document.createElement('span');
        nameLabel.style.cssText = 'font-weight: 600; font-size: 13px;';
        nameLabel.textContent = lightInfo.name;
        header.appendChild(nameLabel);

        var btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap;';

        // Gizmo按钮
        var gizmoBtn = document.createElement('button');
        gizmoBtn.className = 'mp-btn small';
        gizmoBtn.textContent = '移动';
        gizmoBtn.style.cssText = 'padding: 4px 8px; font-size: 11px;';
        gizmoBtn.addEventListener('click', function() {
            toggleGizmo(lightInfo);
        });
        btnGroup.appendChild(gizmoBtn);

        // 显示/隐藏灯光按钮
        var toggleBtn = document.createElement('button');
        toggleBtn.className = 'mp-btn small';
        toggleBtn.textContent = '隐藏';
        toggleBtn.style.cssText = 'padding: 4px 8px; font-size: 11px;';
        toggleBtn.addEventListener('click', function() {
            toggleLightVisibility(lightInfo, toggleBtn);
        });
        btnGroup.appendChild(toggleBtn);

        // 显示/隐藏网格按钮（仅对有可视化网格的灯光显示）
        if (lightInfo.mesh) {
            var meshToggleBtn = document.createElement('button');
            meshToggleBtn.className = 'mp-btn small';
            meshToggleBtn.textContent = '隐藏网格';
            meshToggleBtn.style.cssText = 'padding: 4px 8px; font-size: 11px;';
            meshToggleBtn.addEventListener('click', function() {
                toggleMeshVisibility(lightInfo, meshToggleBtn);
            });
            btnGroup.appendChild(meshToggleBtn);
            lightInfo.meshToggleBtn = meshToggleBtn;
        }

        // 删除按钮
        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'mp-btn danger small';
        deleteBtn.textContent = '删除';
        deleteBtn.style.cssText = 'padding: 4px 8px; font-size: 11px;';
        deleteBtn.addEventListener('click', function() {
            deleteLight(lightInfo);
        });
        btnGroup.appendChild(deleteBtn);

        header.appendChild(btnGroup);
        item.appendChild(header);

        // 类型标签
        var typeLabel = document.createElement('div');
        typeLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 10px;';
        typeLabel.textContent = getLightTypeLabel(lightInfo.type);
        item.appendChild(typeLabel);

        // 颜色控制
        var colorRow = document.createElement('div');
        colorRow.style.cssText = 'margin-bottom: 10px;';

        var colorPicker = new RGBColorPicker({
            label: '颜色',
            color: lightInfo.color,
            mode: 'popup'
        });
        colorPicker.onChange(function(newColor) {
            updateLightColor(lightInfo, newColor);
        });
        colorRow.appendChild(colorPicker.element);

        var quickColorBtn = document.createElement('button');
        quickColorBtn.className = 'mp-btn small';
        quickColorBtn.textContent = '🎨 快速选色';
        quickColorBtn.style.cssText = 'margin-top: 6px; width: 100%; padding: 6px 8px; font-size: 11px;';
        quickColorBtn.addEventListener('click', function() {
            openQuickColorPicker(lightInfo, colorPicker);
        });
        colorRow.appendChild(quickColorBtn);
        item.appendChild(colorRow);

        // 强度控制
        // 上限策略：点光源受 PBR 物理衰减（平方反比）影响最大，上限提到 300（原 3 的 100 倍）；
        // 聚光灯切到标准衰减后强度需求降低，但为了让灯光放远距离后仍有亮度，上限提到 30；
        // 方向光/环境光保持原样（上限 3），不做改动。
        var intensityMax = 3;
        if (lightInfo.type === 'point') {
            intensityMax = 300;
        } else if (lightInfo.type === 'spot') {
            intensityMax = 30;
        }
        var intensitySlider = new Slider({
            label: '强度',
            min: 0,
            max: intensityMax,
            step: 0.01,
            value: lightInfo.intensity,
            showValue: true
        });
        intensitySlider.onChange(function(value) {
            updateLightIntensity(lightInfo, value);
        });
        item.appendChild(intensitySlider.element);

        // 聚光灯：光照角度控制（光锥半角，单位度，范围 1°~90°，对应弧度 0.017~π/2）
        if (lightInfo.type === 'spot') {
            var angleDeg = Math.round((lightInfo.angle || Math.PI / 3) * 180 / Math.PI);
            var angleSlider = new Slider({
                label: '光照角度',
                min: 1,
                max: 90,
                step: 1,
                value: angleDeg,
                showValue: true
            });
            angleSlider.onChange(function(value) {
                updateLightAngle(lightInfo, value);
            });
            item.appendChild(angleSlider.element);
            lightInfo.angleSlider = angleSlider;
        }

        // 位置显示（可编辑）
        if (lightInfo.type !== 'hemispheric') {
            var pos = lightInfo.light.position;
            var posInput = new VectorInput({
                label: '位置',
                components: [
                    { name: 'X', value: parseFloat(pos.x.toFixed(2)), min: -100, max: 100, step: 0.1 },
                    { name: 'Y', value: parseFloat(pos.y.toFixed(2)), min: -100, max: 100, step: 0.1 },
                    { name: 'Z', value: parseFloat(pos.z.toFixed(2)), min: -100, max: 100, step: 0.1 }
                ]
            });
            posInput.onChange(function(values) {
                updateLightPosition(lightInfo, values);
            });
            item.appendChild(posInput.element);
            lightInfo.posInput = posInput;
        }

        // 阴影设置（半球光不支持阴影）
        var shadowSection = createShadowSection(lightInfo);
        item.appendChild(shadowSection);

        // 保存引用
        lightInfo.uiElement = item;
        lightInfo.gizmoBtn = gizmoBtn;
        lightInfo.toggleBtn = toggleBtn;
        lightInfo.colorPicker = colorPicker;
        lightInfo.intensitySlider = intensitySlider;

        listContainer.appendChild(item);
    }

    /**
     * 更新灯光UI（位置变化时）
     */
    function updateLightUI(lightId) {
        var lightInfo = lights.get(lightId);
        if (!lightInfo || !lightInfo.posInput) return;

        var pos = lightInfo.light.position;
        lightInfo.posInput.setValue([pos.x, pos.y, pos.z]);
    }

    /**
     * 切换Gizmo
     */
    function toggleGizmo(lightInfo) {
        if (!gizmoManager) return;

        // 如果当前已经有Gizmo附着在这个灯光上，则取消
        if (currentGizmoLight === lightInfo) {
            gizmoManager.attachToMesh(null);
            currentGizmoLight = null;
            lightInfo.gizmoBtn.textContent = '移动';
            lightInfo.gizmoBtn.classList.remove('primary');
            return;
        }

        // 取消之前的Gizmo
        if (currentGizmoLight) {
            currentGizmoLight.gizmoBtn.textContent = '移动';
            currentGizmoLight.gizmoBtn.classList.remove('primary');
        }

        // 附着到新灯光
        if (lightInfo.mesh) {
            gizmoManager.attachToMesh(lightInfo.mesh);
            currentGizmoLight = lightInfo;
            lightInfo.gizmoBtn.textContent = '完成';
            lightInfo.gizmoBtn.classList.add('primary');
        }
    }

    /**
     * 切换灯光可见性
     */
    function toggleLightVisibility(lightInfo, btn) {
        lightInfo.enabled = !lightInfo.enabled;
        lightInfo.light.setEnabled(lightInfo.enabled && globalLightEnabled);

        if (lightInfo.mesh) {
            lightInfo.mesh.setEnabled(lightInfo.enabled && lightInfo.meshVisible);
        }

        btn.textContent = lightInfo.enabled ? '隐藏' : '显示';
        lightInfo.uiElement.style.opacity = lightInfo.enabled ? '1' : '0.5';
    }

    /**
     * 切换可视化网格可见性
     */
    function toggleMeshVisibility(lightInfo, btn) {
        if (!lightInfo.mesh) return;

        lightInfo.meshVisible = !lightInfo.meshVisible;
        lightInfo.mesh.setEnabled(lightInfo.enabled && lightInfo.meshVisible);

        btn.textContent = lightInfo.meshVisible ? '隐藏网格' : '显示网格';
    }

    /** HSL -> RGB，供快速选色面板使用。 */
    function hslToRgb(h, s, l) {
        h = ((h % 360) + 360) % 360 / 360;
        var r, g, b;
        if (s === 0) return { r:l, g:l, b:l };
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        function hue2rgb(t) {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q-p)*6*t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q-p)*(2/3-t)*6;
            return p;
        }
        r = hue2rgb(h + 1/3); g = hue2rgb(h); b = hue2rgb(h - 1/3);
        return { r:r, g:g, b:b };
    }

    /**
     * 打开公共快速选色面板。所有灯光类型共用这一套颜色数据。
     */
    function openQuickColorPicker(lightInfo, colorPicker) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:16px;';
        var panel = document.createElement('div');
        panel.style.cssText = 'width:min(420px, 94vw); max-height:82vh; overflow:auto; background:var(--color-surface); color:var(--text-primary); border:1px solid var(--color-border); border-radius:12px; padding:14px; box-shadow:0 12px 36px rgba(0,0,0,.35);';

        var head = document.createElement('div');
        head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;';
        var h = document.createElement('div');
        h.textContent = '快速选色';
        h.style.cssText = 'font-size:15px; font-weight:600;';
        head.appendChild(h);
        var close = document.createElement('button');
        close.className = 'mp-btn small'; close.textContent = '关闭';
        close.style.cssText = 'padding:4px 9px; font-size:11px;';
        close.addEventListener('click', function(){ if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
        head.appendChild(close); panel.appendChild(head);

        var hint = document.createElement('div');
        hint.textContent = '每行一种色相，从左到右由淡到浓；浓色更适合氛围灯。';
        hint.style.cssText = 'font-size:11px; color:var(--text-secondary); line-height:1.5; margin-bottom:10px;';
        panel.appendChild(hint);

        QUICK_COLOR_HUES.forEach(function(hue) {
            var row = document.createElement('div');
            row.style.cssText = 'display:grid; grid-template-columns:42px repeat(5,1fr); gap:6px; align-items:center; margin-bottom:7px;';
            var label = document.createElement('div');
            label.textContent = hue.name; label.style.cssText = 'font-size:11px; color:var(--text-secondary);';
            row.appendChild(label);
            QUICK_COLOR_LEVELS.forEach(function(level) {
                var c = hslToRgb(hue.h, level.s, level.l);
                var b = document.createElement('button');
                b.title = hue.name + ' · ' + level.name;
                b.style.cssText = 'height:32px; border-radius:7px; border:1px solid rgba(255,255,255,.20); cursor:pointer; background:rgb(' + Math.round(c.r*255) + ',' + Math.round(c.g*255) + ',' + Math.round(c.b*255) + ');';
                b.addEventListener('click', function() {
                    if (lightInfo) updateLightColor(lightInfo, c);
                    else if (colorPicker) {
                        try { if (typeof colorPicker.setValue === 'function') colorPicker.setValue(c); } catch(e) {}
                        // 即使颜色组件版本没有 setValue，也会通过下面的临时值在创建时读取。
                        colorPicker.__quickColor = c;
                    }
                    if (lightInfo && colorPicker) {
                        try { if (typeof colorPicker.setValue === 'function') colorPicker.setValue(c); } catch(e) {}
                    }
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                });
                row.appendChild(b);
            });
            panel.appendChild(row);
        });

        overlay.addEventListener('click', function(e) { if (e.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); });
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    }

    /**
     * 更新灯光颜色
     */
    function updateLightColor(lightInfo, color) {
        lightInfo.color = color;
        var col = new BABYLON.Color3(color.r, color.g, color.b);
        lightInfo.light.diffuse = col;
        if (lightInfo.type === 'hemispheric' && lightInfo.light.groundColor) {
            // 环境光的地面色保持较低比例，避免快速选色后整个场景阴影区被染得过重。
            lightInfo.light.groundColor = new BABYLON.Color3(color.r * 0.22, color.g * 0.22, color.b * 0.22);
        }

        if (lightInfo.mesh && lightInfo.mesh.material) {
            lightInfo.mesh.material.emissiveColor = col;
        }
    }

    /**
     * 更新灯光强度
     */
    function updateLightIntensity(lightInfo, intensity) {
        lightInfo.intensity = intensity;
        lightInfo.light.intensity = intensity * globalIntensityMultiplier;
    }

    /**
     * 更新聚光灯照射角度（光锥半角）
     * @param lightInfo 灯光信息
     * @param angleDeg 角度（度），范围 1~90
     */
    function updateLightAngle(lightInfo, angleDeg) {
        var rad = angleDeg * Math.PI / 180;
        lightInfo.angle = rad;
        if (lightInfo.light && typeof lightInfo.light.angle === 'number') {
            lightInfo.light.angle = rad;
        }
    }

    /**
     * 更新灯光位置
     */
    function updateLightPosition(lightInfo, values) {
        var pos = new BABYLON.Vector3(values[0], values[1], values[2]);

        lightInfo.light.position = pos;

        if (lightInfo.mesh) {
            lightInfo.mesh.position = pos;
        }
    }

    /**
     * 该灯光是否支持阴影（半球光不支持）
     */
    function hasShadowSupport(lightInfo) {
        return lightInfo && lightInfo.type !== 'hemispheric';
    }

    /**
     * 创建灯光列表项中的"阴影"设置区域
     */
    function createShadowSection(lightInfo) {
        if (!hasShadowSupport(lightInfo)) {
            var noWrap = document.createElement('div');
            noWrap.style.cssText = 'border-top: 1px dashed var(--color-border); padding-top: 10px; margin-top: 4px;';
            var noTitle = document.createElement('div');
            noTitle.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;';
            noTitle.textContent = '阴影 (Shadow)';
            noWrap.appendChild(noTitle);
            var tip = document.createElement('div');
            tip.style.cssText = 'font-size: 11px; color: var(--text-disabled); line-height: 1.5;';
            tip.textContent = '半球光 (Hemispheric) 不支持阴影。';
            noWrap.appendChild(tip);
            return noWrap;
        }

        var wrapper = document.createElement('div');
        wrapper.className = 'light-shadow-section';
        wrapper.style.cssText = 'border-top: 1px dashed var(--color-border); padding-top: 10px; margin-top: 4px;';

        var title = document.createElement('div');
        title.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px;';
        title.textContent = '阴影 (ShadowGenerator)';
        wrapper.appendChild(title);

        var toggle = new mp.ui.ToggleSwitch({
            label: '启用阴影发生器',
            initialState: !!lightInfo.shadowEnabled
        });
        toggle.onChange(function(enabled) {
            setShadowEnabled(lightInfo, enabled);
        });
        wrapper.appendChild(toggle.element);
        lightInfo.shadowToggle = toggle;

        // 高级设置（默认隐藏，启用阴影后显示）
        var advanced = document.createElement('div');
        advanced.style.cssText = 'margin-top: 10px; display: ' + (lightInfo.shadowEnabled ? 'block' : 'none') + ';';

        var sizeDropdown = new mp.ui.Dropdown({
            label: '阴影贴图大小',
            options: SHADOW_MAP_SIZES,
            selectedValue: String(lightInfo.shadowMapSize)
        });
        sizeDropdown.onChange(function(value) {
            lightInfo.shadowMapSize = parseInt(value, 10) || SHADOW_MAP_SIZE_DEFAULT;
            if (lightInfo.shadowEnabled) {
                recreateShadowGenerator(lightInfo);
            }
        });
        advanced.appendChild(sizeDropdown.element);

        var blurToggle = new mp.ui.ToggleSwitch({
            label: '模糊阴影 (PCF)',
            initialState: !!lightInfo.shadowBlur
        });
        blurToggle.onChange(function(enabled) {
            lightInfo.shadowBlur = !!enabled;
            if (lightInfo.shadowGenerator) {
                lightInfo.shadowGenerator.useBlurExponentialShadowMap = lightInfo.shadowBlur;
            }
        });
        advanced.appendChild(blurToggle.element);

        wrapper.appendChild(advanced);
        lightInfo.shadowAdvanced = advanced;

        return wrapper;
    }

    /**
     * 获取可作为阴影投射物的网格（优先模型根网格，其次场景网格，排除灯光可视化网格）
     */
    function getShadowCasterMeshes() {
        var meshes = [];

        if (typeof mp !== 'undefined' && mp.model && typeof mp.model.list === 'function') {
            try {
                var models = mp.model.list();
                for (var i = 0; i < models.length; i++) {
                    if (models[i] && models[i].mesh) {
                        meshes.push(models[i].mesh);
                    }
                }
            } catch (e) { /* 忽略模型桥异常 */ }
        }

        if (meshes.length === 0 && scene && scene.meshes) {
            for (var j = 0; j < scene.meshes.length; j++) {
                var m = scene.meshes[j];
                if (m && !m.lightRef) meshes.push(m);
            }
        }

        return meshes;
    }

    /**
     * 为阴影发生器注册投射物，并让场景网格与材质接收阴影
     */
    function addShadowCasters(sg) {
        if (!sg) return;

        var casters = getShadowCasterMeshes();
        for (var i = 0; i < casters.length; i++) {
            if (casters[i]) {
                try { sg.addShadowCaster(casters[i]); } catch (e) { /* 忽略单个网格失败 */ }
            }
        }

        if (scene && scene.meshes) {
            for (var j = 0; j < scene.meshes.length; j++) {
                var mesh = scene.meshes[j];
                if (!mesh || mesh.lightRef) continue;
                try {
                    mesh.receiveShadows = true;
                    if (mesh.material && typeof mesh.material.receiveShadows !== 'undefined') {
                        mesh.material.receiveShadows = true;
                    }
                } catch (e) { /* 忽略 */ }
            }
        }
    }

    /**
     * 创建阴影发生器
     */
    function createShadowGenerator(lightInfo) {
        if (!scene || !hasShadowSupport(lightInfo)) return null;
        if (lightInfo.shadowGenerator) return lightInfo.shadowGenerator;

        var mapSize = lightInfo.shadowMapSize || SHADOW_MAP_SIZE_DEFAULT;
        var sg = null;

        try {
            if (lightInfo.type === 'point' && typeof BABYLON.PointLightShadowGenerator !== 'undefined') {
                sg = new BABYLON.PointLightShadowGenerator(mapSize, lightInfo.light);
            } else if (typeof BABYLON.ShadowGenerator !== 'undefined') {
                sg = new BABYLON.ShadowGenerator(mapSize, lightInfo.light);
            }
        } catch (e) {
            console.error('[LightManager] 阴影发生器创建异常:', e);
            return null;
        }

        if (!sg) return null;

        if (lightInfo.shadowBlur) {
            sg.useBlurExponentialShadowMap = true;
            if (typeof sg.useKernelBlur !== 'undefined') {
                sg.useKernelBlur = true;
                sg.blurKernel = 32;
            }
        }

        addShadowCasters(sg);
        lightInfo.shadowGenerator = sg;
        return sg;
    }

    /**
     * 释放阴影发生器
     */
    function disposeShadowGenerator(lightInfo) {
        if (lightInfo.shadowGenerator) {
            try { lightInfo.shadowGenerator.dispose(); } catch (e) { /* 忽略 */ }
            lightInfo.shadowGenerator = null;
        }
    }

    /**
     * 按当前大小/模糊设置重建阴影发生器
     */
    function recreateShadowGenerator(lightInfo) {
        disposeShadowGenerator(lightInfo);
        createShadowGenerator(lightInfo);
    }

    /**
     * 开关灯光的阴影发生器
     */
    function setShadowEnabled(lightInfo, enabled) {
        enabled = !!enabled;
        lightInfo.shadowEnabled = enabled;

        if (enabled) {
            var sg = createShadowGenerator(lightInfo);
            if (!sg) {
                lightInfo.shadowEnabled = false;
                if (lightInfo.shadowToggle && typeof lightInfo.shadowToggle.setValue === 'function') {
                    try { lightInfo.shadowToggle.setValue(false); } catch (e) { /* 忽略 */ }
                }
                toast.error('阴影发生器创建失败，当前环境可能不支持阴影', 2500);
                if (lightInfo.shadowAdvanced) lightInfo.shadowAdvanced.style.display = 'none';
                return;
            }
            if (lightInfo.shadowAdvanced) lightInfo.shadowAdvanced.style.display = 'block';
        } else {
            disposeShadowGenerator(lightInfo);
            if (lightInfo.shadowAdvanced) lightInfo.shadowAdvanced.style.display = 'none';
        }
    }

    /**
     * 模型加载后刷新所有已启用阴影发生器的投射物
     */
    function refreshAllShadowCasters() {
        lights.forEach(function(info) {
            if (info.shadowEnabled && info.shadowGenerator) {
                addShadowCasters(info.shadowGenerator);
            }
        });
    }

    /**
     * 删除灯光
     */
    function deleteLight(lightInfo) {
        if (currentGizmoLight === lightInfo) {
            gizmoManager.attachToMesh(null);
            currentGizmoLight = null;
        }

        if (lightInfo.mesh) {
            lightInfo.mesh.material.dispose();
            lightInfo.mesh.dispose();
        }

        disposeShadowGenerator(lightInfo);
        lightInfo.light.dispose();
        lightInfo.uiElement.remove();
        lights.delete(lightInfo.id);
        updateLightCount();

        toast.info('灯光 "' + lightInfo.name + '" 已删除', 2000);
    }

    /**
     * 清空所有灯光
     */
    function clearAllLights() {
        lights.forEach(function(lightInfo) {
            if (lightInfo.mesh) {
                lightInfo.mesh.material.dispose();
                lightInfo.mesh.dispose();
            }
            disposeShadowGenerator(lightInfo);
            lightInfo.light.dispose();
        });
        lights.clear();

        var listContainer = container.querySelector('.light-list-container');
        if (listContainer) {
            listContainer.innerHTML = '';
        }
        updateLightCount();

        if (gizmoManager) {
            gizmoManager.attachToMesh(null);
            currentGizmoLight = null;
        }
    }

    /**
     * 更新灯光计数
     */
    function updateLightCount() {
        var listSection = container.querySelector('.light-list-section');
        if (listSection && listSection.titleCount) {
            listSection.titleCount.textContent = '(' + lights.size + ')';
        }
    }

    /**
     * 获取灯光类型标签
     */
    function getLightTypeLabel(type) {
        var found = LIGHT_TYPES.find(function(t) { return t.value === type; });
        return found ? found.label : type;
    }

    /**
     * 面板显示时调用
     */
    exports.onShown = function() {
        console.log('[LightManager] 面板已显示');
        // 面板显示时重新应用最大同时生效灯光数，确保新加载的材质也生效
        applyMaxSimultaneousLights(maxSimultaneousLights);
    };

    /**
     * 面板隐藏时调用
     */
    exports.onHidden = function() {
        // 隐藏时取消Gizmo
        if (gizmoManager) {
            gizmoManager.attachToMesh(null);
        }
        if (currentGizmoLight) {
            currentGizmoLight.gizmoBtn.textContent = '移动';
            currentGizmoLight.gizmoBtn.classList.remove('primary');
            currentGizmoLight = null;
        }
    };

    /**
     * 释放资源
     */
    exports.dispose = function() {
        // 取消所有事件订阅
        unsubscribers.forEach(function(unsub) { unsub(); });
        unsubscribers = [];

        // 清理Gizmo
        if (gizmoManager) {
            gizmoManager.dispose();
            gizmoManager = null;
        }

        // 清理所有灯光
        clearAllLights();

        container = null;
        scene = null;
        pluginContext = null;
        maxLightsSlider = null;
        userPresetDropdown = null;
        userPresetDesc = null;
    };

})();

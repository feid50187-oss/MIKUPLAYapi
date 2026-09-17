/**
 * Light Aim Tracker - 灯光方向追踪器 V3
 * ---------------------------------------------------------------
 * 核心思路：
 *  - 灯光位置保持不动（你自己摆好），每帧只更新 light.direction；
 *  - 目标点默认 = 人物模型所有可见网格的世界包围盒中心；
 *  - 可选骨骼目标作为辅助模式；
 *  - 效果类似舞台追光灯：灯在原地，光束始终指向人物胸口；
 *  - 也支持把灯光挂到"模型中心"作为兜底（模型无骨骼时）。
 *
 * 特点：
 *  - 位置不动，从根本上避免"绑定后灯消失"的问题；
 *  - 只列 SpotLight / DirectionalLight（Point / Hemispheric 无方向语义）；
 *  - 支持在骨骼世界坐标上叠加瞄准偏移，微调瞄准点高低；
 *  - 拖动灯位置（如灯光管理器 Gizmo）后，方向下一帧自动重新计算；
 *  - 支持多绑定并存，独立启用/解绑；
 *  - 解绑时恢复灯光原始方向；提供"恢复全部方向"按钮；
 *  - 灯光被外部 dispose 时自动解绑；scene:reset 清空全部绑定；
 *  - tick 每绑定 try/catch + 数值校验，异常不写入、不阻断其它绑定。
 *
 * V3 重构：
 *  - 默认不再把绑定瞬间的坐标当作追踪目标；
 *  - 每一帧重新计算人物模型中心的世界坐标，重点实时跟随 X/Z；
 *  - 灯光位置保持不动，只重新计算“灯光世界位置 -> 当前人物中心”的方向；
 *  - 灯光存在 parent 时，优先取得灯光绝对世界位置，避免局部 position 误算；
 *  - 模型中心使用所有有效子网格 world bounding box 的合并中心，而不是模型 root 原点；
 *  - 保留骨骼模式，但模型中心成为默认模式。
 *
 * v2 修复：
 *  - 关键：每帧主动调用 Skeleton.prepare()，强制刷新骨骼世界矩阵，
 *    解决"能追踪但数值不实时跟随动画"的问题；
 *  - 绑定项新增实时目标坐标显示（每 10 帧刷新一次 DOM）；
 *  - onAfterRenderObservable 兜底（若宿主暂停 onBeforeRender，可换）；
 *  - 更严格的数值校验（NaN / 超大值 / 距离过近）。
 */

var exports = {};

(function () {
    'use strict';

    var TAG = '[LightAimTracker]';
    var toast = mp.ui.toast;
    var Dropdown = mp.ui.Dropdown;
    var VectorInput = mp.ui.VectorInput;

    // ---------- 状态 ----------
    var scene = null;
    var ctx = null;
    var container = null;
    var disposed = false;

    var bindings = new Map();      // id -> binding
    var bindingCounter = 0;
    var frameObserver = null;
    var unsubscribers = [];
    var bonesCache = { modelId: null, list: null };
    var frameCount = 0;

    // ---------- 复用缓冲 ----------
    var _tmpDir = null;
    var _tmpScale = null;
    var _tmpQuat = null;
    var _tmpTrans = null;
    var _tmpBoneWorldMatrix = null;
    var _tmpLightWorldPos = null;
    var _tmpMin = null;
    var _tmpMax = null;
    var _tmpCenter = null;

    var MIN_DISTANCE = 0.001;

    var CHEST_KEYWORDS = [
        '上半身2', '上半身２',
        '胸',
        'chest',
        '上半身',
        'spine2', 'spine1', 'spine',
        '首',
        'neck',
        'センター', 'center'
    ];

    // ---------- UI 引用 ----------
    var lightHost = null;
    var lightDropdown = null;
    var modelHost = null;
    var modelDropdown = null;
    var boneHost = null;
    var boneDropdown = null;
    var offsetInput = null;
    var listContainer = null;
    var countLabel = null;
    var bindBtn = null;
    var resetAllBtn = null;

    // ============================================================
    // 一、基础工具
    // ============================================================
    function safeCall(fn, fallback) {
        try { return fn(); } catch (e) { return fallback; }
    }

    function safeDisposeDropdown(dd) {
        if (dd && typeof dd.dispose === 'function') {
            try { dd.dispose(); } catch (e) {}
        }
    }

    function ensureBuffers() {
        if (!_tmpDir)   _tmpDir   = new BABYLON.Vector3(0, -1, 0);
        if (!_tmpScale) _tmpScale = new BABYLON.Vector3(1, 1, 1);
        if (!_tmpQuat)  _tmpQuat  = new BABYLON.Quaternion();
        if (!_tmpTrans) _tmpTrans = new BABYLON.Vector3(0, 0, 0);
        if (!_tmpLightWorldPos) _tmpLightWorldPos = new BABYLON.Vector3(0, 0, 0);
        if (!_tmpMin) _tmpMin = new BABYLON.Vector3(0, 0, 0);
        if (!_tmpMax) _tmpMax = new BABYLON.Vector3(0, 0, 0);
        if (!_tmpCenter) _tmpCenter = new BABYLON.Vector3(0, 0, 0);
    }

    function isVecFinite(v) {
        return !!v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z);
    }

    function isAimableLight(light) {
        if (!light) return false;
        var cls = light.getClassName ? light.getClassName() : '';
        return cls === 'SpotLight' || cls === 'DirectionalLight';
    }

    function getAimableLights() {
        if (!scene || !scene.lights) return [];
        var out = [];
        for (var i = 0; i < scene.lights.length; i++) {
            var l = scene.lights[i];
            if (isAimableLight(l)) out.push(l);
        }
        return out;
    }

    function isLightAlive(light) {
        if (!light || !scene || !scene.lights) return false;
        return scene.lights.indexOf(light) !== -1;
    }

    function getModels() {
        try { return (mp.model.list && mp.model.list()) || []; } catch (e) { return []; }
    }

    function findModelById(id) {
        if (!id) return null;
        var list = getModels();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(id)) return list[i];
        }
        return null;
    }

    function findLightByUid(uid) {
        if (!uid) return null;
        var list = getAimableLights();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].uniqueId) === String(uid)) return list[i];
        }
        return null;
    }

    // ============================================================
    // 二、骨骼枚举
    // ============================================================
    function collectBones(model) {
        var result = [];
        var seen = {};
        if (!model || !model.mesh) return result;
        var root = model.mesh;

        function walkMesh(mesh) {
            if (!mesh) return;
            var sk = mesh.skeleton;
            if (sk && sk.bones && sk.bones.length) {
                for (var i = 0; i < sk.bones.length; i++) {
                    var bone = sk.bones[i];
                    if (!bone) continue;
                    if (seen[bone.uniqueId]) continue;
                    seen[bone.uniqueId] = true;
                    result.push({
                        key: 'sk_' + bone.uniqueId,
                        bone: bone,
                        boneType: 'skeleton',
                        name: String(bone.name || ('骨 ' + bone.uniqueId))
                    });
                }
            }
            var kids = safeCall(function () { return mesh.getChildMeshes(false) || []; }, []);
            for (var j = 0; j < kids.length; j++) walkMesh(kids[j]);
        }
        walkMesh(root);

        if (result.length === 0) {
            var descs = safeCall(function () { return root.getDescendants(true) || []; }, []);
            for (var k = 0; k < descs.length; k++) {
                var n = descs[k];
                if (!n || !n.name) continue;
                if (n instanceof BABYLON.AbstractMesh) continue;
                if (seen[n.uniqueId]) continue;
                seen[n.uniqueId] = true;
                result.push({
                    key: 'tn_' + n.uniqueId,
                    bone: n,
                    boneType: 'transform',
                    name: String(n.name)
                });
            }
        }

        result.sort(function (a, b) {
            return String(a.name).localeCompare(String(b.name), 'ja');
        });
        return result;
    }

    function collectBonesForSelectedModel() {
        var model = getSelectedModel();
        if (!model) return [];
        var key = String(model.id);
        if (bonesCache.modelId === key && bonesCache.list) return bonesCache.list;
        var list = collectBones(model);
        bonesCache = { modelId: key, list: list };
        return list;
    }

    function pickDefaultChestBoneKey(bones) {
        if (!bones || !bones.length) return '';
        for (var p = 0; p < CHEST_KEYWORDS.length; p++) {
            var kw = CHEST_KEYWORDS[p];
            for (var i = 0; i < bones.length; i++) {
                var n = String(bones[i].name || '');
                if (n.indexOf(kw) !== -1) return bones[i].key;
            }
        }
        return '';
    }

    // ============================================================
    // 三、当前选中项
    // ============================================================
    function getSelectedModel() {
        if (!modelDropdown) return null;
        return findModelById(modelDropdown.getValue());
    }

    function getSelectedLight() {
        if (!lightDropdown) return null;
        return findLightByUid(lightDropdown.getValue());
    }

    function getSelectedBoneEntry() {
        if (!boneDropdown) return null;
        var key = boneDropdown.getValue();
        if (!key) return null;
        var list = collectBonesForSelectedModel();
        for (var i = 0; i < list.length; i++) {
            if (list[i].key === key) return list[i];
        }
        return null;
    }

    // ============================================================
    // 四、骨骼世界矩阵 / 世界坐标
    // ============================================================
    /**
     * 关键：主动刷新骨架，让 _absoluteMatrix 反映当前动画帧。
     * 只对用到的骨架调用一次（去重）。
     */
    function prepareAllBoundSkeletons() {
        var seen = {};
        bindings.forEach(function (b) {
            if (!b.enabled) return;
            if (b.boneType !== 'skeleton' || !b.root) return;
            var sk = safeCall(function () { return b.root.skeleton; }, null);
            if (!sk || seen[sk.uniqueId]) return;
            seen[sk.uniqueId] = true;
            safeCall(function () { sk.prepare(); }, null);
        });
    }

    function computeBoneWorldMatrix(binding) {
        var bone = binding.bone;
        var rootMesh = binding.root;
        if (!bone) return null;

        // Babylon.js 的 Skeleton.Bone 已经提供了“骨骼 -> 世界空间”的转换。
        // 不再手动执行 absoluteMatrix * rootWorldMatrix，避免重复应用模型变换。
        if (binding.boneType === 'skeleton') {
            safeCall(function () {
                if (rootMesh && typeof rootMesh.computeWorldMatrix === 'function') {
                    rootMesh.computeWorldMatrix(true);
                }
            }, null);

            // getAbsoluteTransformToRef(mesh, result) 在支持的版本中会直接给出
            // 该骨骼相对于指定 mesh 的绝对变换。
            if (rootMesh && typeof bone.getAbsoluteTransformToRef === 'function') {
                try {
                    if (!_tmpBoneWorldMatrix) {
                        _tmpBoneWorldMatrix = BABYLON.Matrix.Identity();
                    }
                    bone.getAbsoluteTransformToRef(rootMesh, _tmpBoneWorldMatrix);
                    return _tmpBoneWorldMatrix;
                } catch (e) {
                    // 继续尝试兼容 API
                }
            }

            if (rootMesh && typeof bone.getAbsoluteTransform === 'function') {
                try {
                    return bone.getAbsoluteTransform(rootMesh);
                } catch (e2) {
                    // 继续尝试旧版 API
                }
            }

            var am = safeCall(function () {
                return (typeof bone.getAbsoluteMatrix === 'function') ? bone.getAbsoluteMatrix() : null;
            }, null);
            return am || null;
        }

        if (bone.computeWorldMatrix && bone.getWorldMatrix) {
            safeCall(function () { bone.computeWorldMatrix(true); }, null);
            return safeCall(function () { return bone.getWorldMatrix(); }, null);
        }
        return null;
    }

    /**
     * 计算“人物模型中心”的世界坐标。
     * 不使用 root.getAbsolutePosition()，因为那通常只是模型根节点原点，
     * 并不等于人物几何体中心。每帧遍历模型的有效网格并合并 world bounding box。
     */
    function computeModelCenterWorldPosition(binding, out) {
        var root = binding.root;
        if (!root || !scene) return false;

        var meshes = [];
        try {
            meshes.push(root);
            var children = root.getChildMeshes ? root.getChildMeshes(false) : [];
            for (var i = 0; i < children.length; i++) meshes.push(children[i]);
        } catch (e) {}

        var hasBounds = false;
        var minX = Infinity, minY = Infinity, minZ = Infinity;
        var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (var j = 0; j < meshes.length; j++) {
            var mesh = meshes[j];
            if (!mesh) continue;
            try {
                if (mesh.isDisposed && mesh.isDisposed()) continue;
                if (mesh.isEnabled && !mesh.isEnabled()) continue;
                if (!mesh.getBoundingInfo) continue;

                mesh.computeWorldMatrix(true);
                var bb = mesh.getBoundingInfo().boundingBox;
                if (!bb || !bb.minimumWorld || !bb.maximumWorld) continue;
                var mn = bb.minimumWorld;
                var mx = bb.maximumWorld;
                if (!isVecFinite(mn) || !isVecFinite(mx)) continue;

                if (mn.x < minX) minX = mn.x;
                if (mn.y < minY) minY = mn.y;
                if (mn.z < minZ) minZ = mn.z;
                if (mx.x > maxX) maxX = mx.x;
                if (mx.y > maxY) maxY = mx.y;
                if (mx.z > maxZ) maxZ = mx.z;
                hasBounds = true;
            } catch (e2) {}
        }

        if (!hasBounds) {
            // 几何包围盒不可用时，退回模型 root 世界位置。
            try {
                root.computeWorldMatrix(true);
                var rp = root.getAbsolutePosition ? root.getAbsolutePosition() : root.position;
                if (rp && isVecFinite(rp)) {
                    out.copyFrom(rp);
                    return true;
                }
            } catch (e3) {}
            return false;
        }

        out.x = (minX + maxX) * 0.5;
        out.y = (minY + maxY) * 0.5;
        out.z = (minZ + maxZ) * 0.5;
        return isVecFinite(out);
    }

    /**
     * 获取灯光的世界位置。
     * Light.position 在存在 parent 时可能是局部坐标，因此优先使用绝对位置。
     */
    function computeLightWorldPosition(light, out) {
        if (!light || !out) return false;
        try {
            if (typeof light.getAbsolutePosition === 'function') {
                var ap = light.getAbsolutePosition();
                if (ap && isVecFinite(ap)) {
                    out.copyFrom(ap);
                    return true;
                }
            }
        } catch (e) {}
        try {
            if (light.position && isVecFinite(light.position)) {
                out.copyFrom(light.position);
                return true;
            }
        } catch (e2) {}
        return false;
    }

    function computeTargetWorldPosition(binding, out) {
        ensureBuffers();

        if (binding.useRoot || !binding.bone) {
            return computeModelCenterWorldPosition(binding, out);
        }

        var bone = binding.bone;
        var rootMesh = binding.root;
        if (!bone) return false;

        // 首选 Babylon Bone 自带的绝对世界坐标接口。
        // 这是本次重构的核心：每一帧直接读取当前动画更新后的骨骼世界位置，
        // 不再通过“骨骼矩阵 × 模型世界矩阵”自行拼接坐标空间。
        if (rootMesh && typeof bone.getAbsolutePositionToRef === 'function') {
            try {
                rootMesh.computeWorldMatrix(true);
                bone.getAbsolutePositionToRef(rootMesh, out);
                return isVecFinite(out);
            } catch (e) {
                // 兼容不同 Babylon 版本的参数形式
            }
        }

        if (rootMesh && typeof bone.getAbsolutePosition === 'function') {
            try {
                rootMesh.computeWorldMatrix(true);
                var wp = bone.getAbsolutePosition(rootMesh);
                if (wp && isVecFinite(wp)) {
                    out.x = wp.x; out.y = wp.y; out.z = wp.z;
                    return true;
                }
            } catch (e2) {
                // 继续使用矩阵兼容路径
            }
        }

        var wm = computeBoneWorldMatrix(binding);
        if (!wm) return false;

        _tmpScale.set(1, 1, 1);
        _tmpQuat.set(0, 0, 0, 1);
        _tmpTrans.set(0, 0, 0);
        try {
            wm.decompose(_tmpScale, _tmpQuat, _tmpTrans);
        } catch (e3) {
            return false;
        }
        if (!isVecFinite(_tmpTrans)) return false;

        out.x = _tmpTrans.x;
        out.y = _tmpTrans.y;
        out.z = _tmpTrans.z;
        return true;
    }

    // ============================================================
    // 五、每帧更新：只改 direction
    // ============================================================
    function tick() {
        if (disposed) return;
        if (!bindings.size) return;
        if (!scene || !scene.lights) return;

        ensureBuffers();
        frameCount++;

        // ★ 关键：刷新所有绑定的骨架，让骨骼绝对矩阵反映当前动画帧
        prepareAllBoundSkeletons();

        var invalidIds = null;
        var updateDebug = (frameCount % 10) === 0;

        bindings.forEach(function (b, id) {
            if (!b.enabled) return;
            if (!b.light || !b.light.position || !b.light.direction) return;
            if (!isLightAlive(b.light)) {
                if (!invalidIds) invalidIds = [];
                invalidIds.push(id);
                return;
            }

            try {
                if (!b._targetPos) b._targetPos = new BABYLON.Vector3(0, 0, 0);

                if (!computeTargetWorldPosition(b, b._targetPos)) {
                    b._badCount = (b._badCount || 0) + 1;
                    if (b._badCount === 30 && !b._warned) {
                        b._warned = true;
                        toast.info('目标骨骼矩阵异常，该绑定暂不生效：' + b.targetName, 2600);
                    }
                    if (updateDebug && b._debugEl) {
                        b._debugEl.textContent = '目标：读取失败';
                    }
                    return;
                }
                b._badCount = 0;
                b._warned = false;

                var tx = b._targetPos.x + b.offset.x;
                var ty = b._targetPos.y + b.offset.y;
                var tz = b._targetPos.z + b.offset.z;

                // 关键：目标和灯光都必须先取得“世界坐标”，再计算世界方向。
                // 不再直接使用 light.position，避免 parent/局部坐标导致方向锁在错误空间。
                if (!computeLightWorldPosition(b.light, _tmpLightWorldPos)) return;

                var dx = tx - _tmpLightWorldPos.x;
                var dy = ty - _tmpLightWorldPos.y;
                var dz = tz - _tmpLightWorldPos.z;

                var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (!isFinite(len) || len < MIN_DISTANCE) return;

                _tmpDir.set(dx / len, dy / len, dz / len);
                if (!isVecFinite(_tmpDir)) return;

                b.light.direction.copyFrom(_tmpDir);

                // 实时调试：每 10 帧更新一次 DOM
                if (updateDebug && b._debugEl) {
                    b._debugEl.textContent =
                        '目标 (' +
                        tx.toFixed(1) + ', ' +
                        ty.toFixed(1) + ', ' +
                        tz.toFixed(1) + ')';
                }
            } catch (e) {
                console.warn(TAG, 'tick 单绑定异常，已跳过:', b.lightName, e);
            }
        });

        if (invalidIds && invalidIds.length) {
            setTimeout(function () {
                if (disposed) return;
                var names = [];
                invalidIds.forEach(function (id) {
                    var b = bindings.get(id);
                    if (b) {
                        names.push(b.lightName);
                        unbind(id, { silent: true, restore: false });
                    }
                });
                if (names.length) {
                    toast.info('灯光已被删除，自动解绑 ' + names.length + ' 项', 2400);
                }
            }, 0);
        }
    }

    // ============================================================
    // 六、下拉刷新
    // ============================================================
    function refreshLightDropdown() {
        if (!lightHost) return;
        var prev = lightDropdown ? safeCall(function () { return lightDropdown.getValue(); }, '') : '';

        var lights = getAimableLights();
        var options = lights.map(function (l) {
            var cls = l.getClassName ? l.getClassName() : 'Light';
            return {
                value: String(l.uniqueId),
                label: (l.name || ('灯 ' + l.uniqueId)) + ' · ' + cls
            };
        });
        if (options.length === 0) {
            options = [{ value: '', label: '— 场景中暂无聚光灯/方向光 —' }];
        }

        safeDisposeDropdown(lightDropdown);
        lightHost.innerHTML = '';
        var keep = prev && options.some(function (o) { return o.value === prev; }) ? prev : options[0].value;
        lightDropdown = new Dropdown({
            options: options,
            selectedValue: keep,
            placeholder: '选择灯光'
        });
        lightHost.appendChild(lightDropdown.element);
    }

    function refreshModelDropdown() {
        if (!modelHost) return;
        var prev = modelDropdown ? safeCall(function () { return modelDropdown.getValue(); }, '') : '';

        var models = getModels().filter(function (m) { return m && m.mesh; });
        var options = models.map(function (m) {
            return { value: String(m.id), label: m.name || String(m.id) };
        });
        if (options.length === 0) {
            options = [{ value: '', label: '— 场景中暂无模型 —' }];
        }

        safeDisposeDropdown(modelDropdown);
        modelHost.innerHTML = '';
        var keep = prev && options.some(function (o) { return o.value === prev; }) ? prev : options[0].value;
        modelDropdown = new Dropdown({
            options: options,
            selectedValue: keep,
            placeholder: '选择模型'
        });
        modelDropdown.onChange(function () {
            bonesCache = { modelId: null, list: null };
            refreshBoneDropdown();
        });
        modelHost.appendChild(modelDropdown.element);
    }

    function refreshBoneDropdown() {
        if (!boneHost) return;
        var prevKey = boneDropdown ? safeCall(function () { return boneDropdown.getValue(); }, '') : null;

        var bones = collectBonesForSelectedModel();

        var options = [{ value: '', label: '【模型中心】' }];
        for (var i = 0; i < bones.length; i++) {
            options.push({ value: bones[i].key, label: bones[i].name });
        }

        var keep;
        if (prevKey !== null && options.some(function (o) { return o.value === prevKey; })) {
            keep = prevKey;
        } else {
            keep = ''; // V3 默认模型中心，不再自动选择胸骨
        }

        safeDisposeDropdown(boneDropdown);
        boneHost.innerHTML = '';
        boneDropdown = new Dropdown({
            options: options,
            selectedValue: keep,
            placeholder: '选择瞄准目标'
        });
        boneHost.appendChild(boneDropdown.element);
    }

    // ============================================================
    // 七、绑定 / 解绑
    // ============================================================
    function doBind() {
        var light = getSelectedLight();
        var model = getSelectedModel();
        var boneEntry = getSelectedBoneEntry();
        var offset = offsetInput ? offsetInput.getValue() : [0, 0, 0];

        if (!light) { toast.info('请先选择一个灯光', 1800); return; }
        if (!model) { toast.info('请先选择一个模型', 1800); return; }

        var existingId = null;
        bindings.forEach(function (b, id) {
            if (b.light === light) existingId = id;
        });
        if (existingId) {
            toast.info('该灯光已存在绑定，请先解绑再试', 2000);
            return;
        }

        bindingCounter++;
        var id = 'la_' + Date.now() + '_' + bindingCounter;

        var originalDir = light.direction ? light.direction.clone() : null;

        var useRoot = !boneEntry;

        var binding = {
            id: id,
            light: light,
            lightName: light.name || ('灯 ' + light.uniqueId),
            modelId: model.id,
            modelName: model.name || String(model.id),
            root: model.mesh,
            bone: boneEntry ? boneEntry.bone : null,
            boneType: boneEntry ? boneEntry.boneType : null,
            targetName: boneEntry ? boneEntry.name : '模型中心',
            useRoot: useRoot,
            offset: { x: Number(offset[0]) || 0, y: Number(offset[1]) || 0, z: Number(offset[2]) || 0 },
            enabled: true,
            uiElement: null,
            _targetPos: new BABYLON.Vector3(0, 0, 0),
            _badCount: 0,
            _warned: false,
            _debugEl: null,
            originalDirection: originalDir
        };

        // 绑定前先采样两次，确认骨骼矩阵能读出来
        try {
            if (!binding._testPos) binding._testPos = new BABYLON.Vector3(0, 0, 0);
            if (!computeTargetWorldPosition(binding, binding._testPos)) {
                toast.error('目标骨骼矩阵异常，绑定已取消。请尝试其他骨骼或"模型中心"。', 2800);
                return;
            }
        } catch (e) {
            toast.error('目标骨骼矩阵异常，绑定已取消。', 2800);
            return;
        }

        bindings.set(id, binding);
        addBindingToUI(binding);
        updateCount();

        try { tick(); } catch (e) {}

        toast.success('已绑定：' + binding.lightName + ' → ' + binding.targetName + '（实时追踪）', 2200);
    }

    function unbind(id, opts) {
        opts = opts || {};
        var b = bindings.get(id);
        if (!b) return;

        if (opts.restore !== false && b.light && b.originalDirection && b.light.direction) {
            try { b.light.direction.copyFrom(b.originalDirection); } catch (e) {}
        }

        if (b.uiElement && b.uiElement.parentNode) b.uiElement.parentNode.removeChild(b.uiElement);
        b.uiElement = null;
        b.light = null;
        b.bone = null;
        b.root = null;
        b._debugEl = null;
        bindings.delete(id);
        updateCount();

        if (!opts.silent) toast.info('已解绑：' + b.lightName, 1800);
    }

    function resetAllDirections() {
        if (!bindings.size) {
            toast.info('暂无绑定需要重置', 1800);
            return;
        }
        var n = 0;
        bindings.forEach(function (b) {
            if (!b.light || !b.originalDirection) return;
            try {
                b.light.direction.copyFrom(b.originalDirection);
                n++;
            } catch (e) {}
        });
        toast.success('已恢复 ' + n + ' 盏灯的原始方向（下一帧起继续追踪）', 2600);
    }

    function setBindingEnabled(id, enabled) {
        var b = bindings.get(id);
        if (!b) return;
        b.enabled = !!enabled;
    }

    function setBindingOffset(id, arr) {
        var b = bindings.get(id);
        if (!b) return;
        b.offset = {
            x: Number(arr[0]) || 0,
            y: Number(arr[1]) || 0,
            z: Number(arr[2]) || 0
        };
    }

    // ============================================================
    // 八、绑定列表 UI
    // ============================================================
    function addBindingToUI(b) {
        if (!listContainer) return;

        var item = document.createElement('div');
        item.className = 'lat-binding-item';
        item.style.cssText = [
            'background:var(--color-bg)','border:1px solid var(--color-border)',
            'border-radius:var(--radius-sm)','padding:10px','display:flex',
            'flex-direction:column','gap:8px'
        ].join(';');

        var header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

        var title = document.createElement('div');
        title.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
        title.textContent = b.lightName;
        title.title = b.lightName + ' → ' + b.targetName + ' (' + b.modelName + ')';
        header.appendChild(title);

        var delBtn = document.createElement('button');
        delBtn.className = 'mp-btn danger small';
        delBtn.textContent = '解绑';
        delBtn.style.cssText = 'padding:4px 8px;font-size:11px;flex:0 0 auto;';
        delBtn.addEventListener('click', function () { unbind(b.id); });
        header.appendChild(delBtn);
        item.appendChild(header);

        var sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        sub.textContent = '→ ' + b.targetName + '  ·  ' + b.modelName;
        item.appendChild(sub);

        // 实时目标坐标显示
        var debugEl = document.createElement('div');
        debugEl.style.cssText = 'font-family:monospace;font-size:11px;color:var(--text-disabled);background:rgba(0,0,0,0.04);border-radius:6px;padding:4px 8px;';
        debugEl.textContent = '目标：读取中…';
        item.appendChild(debugEl);
        b._debugEl = debugEl;

        try {
            var t = new mp.ui.ToggleSwitch({ label: '启用', initialState: b.enabled });
            t.onChange(function (v) { setBindingEnabled(b.id, v); });
            item.appendChild(t.element);
        } catch (e) {}

        var off = new VectorInput({
            label: '瞄准偏移',
            components: [
                { name: 'X', value: b.offset.x, min: -200, max: 200, step: 0.1 },
                { name: 'Y', value: b.offset.y, min: -200, max: 200, step: 0.1 },
                { name: 'Z', value: b.offset.z, min: -200, max: 200, step: 0.1 }
            ]
        });
        off.onChange(function (vals) { setBindingOffset(b.id, vals); });
        item.appendChild(off.element);

        b.uiElement = item;
        listContainer.appendChild(item);
    }

    function updateCount() {
        if (countLabel) countLabel.textContent = '(' + bindings.size + ')';
    }

    // ============================================================
    // 九、UI 构建
    // ============================================================
    function buildUI() {
        container = document.createElement('div');
        container.style.cssText = [
            'padding:16px','display:flex','flex-direction:column','gap:14px',
            'height:100%','overflow-y:auto','box-sizing:border-box',
            'color:var(--text-primary)'
        ].join(';');

        var title = document.createElement('div');
        title.style.cssText = 'font-size:16px;font-weight:700;color:var(--text-primary);';
        title.textContent = '灯光方向追踪';
        container.appendChild(title);

        var tip = document.createElement('div');
        tip.style.cssText = 'font-size:11px;line-height:1.6;color:var(--text-secondary);';
        tip.textContent = '灯光位置不动，每帧重新计算人物模型中心的世界坐标，并让聚光灯方向实时追踪人物的 X/Z 移动。默认使用模型几何中心；也可手动选择骨骼。';
        container.appendChild(tip);

        var lightLabel = document.createElement('div');
        lightLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        lightLabel.textContent = '灯光（聚光灯 / 方向光）';
        container.appendChild(lightLabel);
        lightHost = document.createElement('div');
        container.appendChild(lightHost);

        var modelLabel = document.createElement('div');
        modelLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        modelLabel.textContent = '模型';
        container.appendChild(modelLabel);
        modelHost = document.createElement('div');
        container.appendChild(modelHost);

        var boneLabel = document.createElement('div');
        boneLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        boneLabel.textContent = '瞄准目标（默认：模型中心；也可选择骨骼）';
        container.appendChild(boneLabel);
        boneHost = document.createElement('div');
        container.appendChild(boneHost);

        offsetInput = new VectorInput({
            label: '瞄准偏移（世界坐标）',
            components: [
                { name: 'X', value: 0, min: -200, max: 200, step: 0.1 },
                { name: 'Y', value: 0, min: -200, max: 200, step: 0.1 },
                { name: 'Z', value: 0, min: -200, max: 200, step: 0.1 }
            ]
        });
        container.appendChild(offsetInput.element);

        bindBtn = document.createElement('button');
        bindBtn.className = 'mp-btn primary';
        bindBtn.style.cssText = 'width:100%;min-height:42px;font-size:14px;font-weight:600;';
        bindBtn.textContent = '＋ 让灯光瞄准该目标';
        bindBtn.addEventListener('click', doBind);
        container.appendChild(bindBtn);

        resetAllBtn = document.createElement('button');
        resetAllBtn.className = 'mp-btn';
        resetAllBtn.style.cssText = 'width:100%;min-height:38px;font-size:13px;';
        resetAllBtn.textContent = '↺ 恢复全部灯光原始方向';
        resetAllBtn.addEventListener('click', resetAllDirections);
        container.appendChild(resetAllBtn);

        var listTitle = document.createElement('div');
        listTitle.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;color:var(--text-primary);margin-top:6px;';
        var listTitleText = document.createElement('span');
        listTitleText.textContent = '追踪绑定';
        listTitle.appendChild(listTitleText);
        countLabel = document.createElement('span');
        countLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        countLabel.textContent = '(0)';
        listTitle.appendChild(countLabel);
        container.appendChild(listTitle);

        listContainer = document.createElement('div');
        listContainer.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
        container.appendChild(listContainer);

        refreshLightDropdown();
        refreshModelDropdown();
        refreshBoneDropdown();

        return container;
    }

    // ============================================================
    // 十、生命周期
    // ============================================================
    exports.createPanel = function (context) {
        ctx = context;
        scene = context.scene;

        buildUI();

        // ★ 用 onBeforeRender 触发；tick 内主动刷新骨架
        frameObserver = scene.onBeforeRenderObservable.add(tick);

        try {
            var unModel = mp.model.onChanged(function () {
                setTimeout(function () {
                    if (disposed) return;
                    refreshModelDropdown();
                    refreshBoneDropdown();
                }, 0);
            });
            if (typeof unModel === 'function') unsubscribers.push(unModel);
        } catch (e) {
            console.warn(TAG, 'mp.model.onChanged 订阅失败:', e);
        }

        try {
            var unLoaded = context.eventBus.on('model:loaded', function () {
                setTimeout(function () {
                    if (disposed) return;
                    refreshModelDropdown();
                    refreshBoneDropdown();
                }, 0);
            });
            if (typeof unLoaded === 'function') unsubscribers.push(unLoaded);

            var unRemoved = context.eventBus.on('model:removed', function () {
                setTimeout(function () {
                    if (disposed) return;
                    refreshModelDropdown();
                    refreshBoneDropdown();
                    var toRemove = [];
                    bindings.forEach(function (b, id) {
                        if (!findModelById(b.modelId)) toRemove.push(id);
                    });
                    toRemove.forEach(function (id) {
                        unbind(id, { silent: true, restore: true });
                    });
                }, 0);
            });
            if (typeof unRemoved === 'function') unsubscribers.push(unRemoved);

            var unReset = context.eventBus.on('scene:reset', function () {
                setTimeout(function () {
                    if (disposed) return;
                    var had = bindings.size;
                    Array.from(bindings.keys()).forEach(function (id) {
                        unbind(id, { silent: true, restore: false });
                    });
                    refreshLightDropdown();
                    if (had > 0) toast.info('场景已重置，' + had + ' 项追踪已清除', 2400);
                }, 0);
            });
            if (typeof unReset === 'function') unsubscribers.push(unReset);
        } catch (e) {
            console.warn(TAG, 'eventBus 订阅失败:', e);
        }

        return container;
    };

    exports.onShown = function () {
        refreshLightDropdown();
        refreshModelDropdown();
        refreshBoneDropdown();
    };

    exports.onHidden = function () {
        // 面板切走但追踪继续。
    };

    exports.dispose = function () {
        disposed = true;
        if (frameObserver) {
            try { scene.onBeforeRenderObservable.remove(frameObserver); } catch (e) {}
            frameObserver = null;
        }
        unsubscribers.forEach(function (fn) { try { fn(); } catch (e) {} });
        unsubscribers = [];

        bindings.forEach(function (b) {
            if (b.uiElement && b.uiElement.parentNode) b.uiElement.parentNode.removeChild(b.uiElement);
            b.uiElement = null;
            b.light = null;
            b.bone = null;
            b.root = null;
            b._debugEl = null;
        });
        bindings.clear();
        bonesCache = { modelId: null, list: null };

        safeDisposeDropdown(lightDropdown);
        safeDisposeDropdown(modelDropdown);
        safeDisposeDropdown(boneDropdown);
        lightDropdown = null;
        modelDropdown = null;
        boneDropdown = null;
        offsetInput = null;
        listContainer = null;
        countLabel = null;
        lightHost = null;
        modelHost = null;
        boneHost = null;
        bindBtn = null;
        resetAllBtn = null;
        container = null;
        scene = null;
        ctx = null;

        _tmpDir = null;
        _tmpScale = null;
        _tmpQuat = null;
        _tmpTrans = null;
        _tmpLightWorldPos = null;
        _tmpMin = null;
        _tmpMax = null;
        _tmpCenter = null;
    };

    console.log(TAG, '已注册');
})();
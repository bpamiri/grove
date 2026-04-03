import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import { PipelinePreview } from "./Pipeline";

interface StepDraft {
  id: string;
  type: "worker" | "verdict";
  label: string;
  prompt: string;
  skills: string[];
  sandbox: "read-write" | "read-only";
  result_file: string;
  result_key: string;
  on_success: string;
  on_failure: string;
  max_retries: number;
}

interface SkillManifest {
  name: string;
  description: string;
  suggested_steps?: string[];
}

interface Props {
  name: string | null; // null = new path
  onSave: () => void;
  onCancel: () => void;
}

function emptyStep(): StepDraft {
  return {
    id: "", type: "worker", label: "", prompt: "", skills: [],
    sandbox: "read-write", result_file: "", result_key: "",
    on_success: "", on_failure: "", max_retries: 0,
  };
}

export default function PathEditor({ name, onSave, onCancel }: Props) {
  const [pathName, setPathName] = useState(name ?? "");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()]);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<number | null>(0);
  const dragIdx = useRef<number | null>(null);

  // Fetch skills for multi-select
  useEffect(() => {
    api<SkillManifest[]>("/api/skills").then(setSkills).catch(() => {});
  }, []);

  // Fetch full path data (including prompts) when editing an existing path
  useEffect(() => {
    if (!name) return;
    api<{ description: string; steps: any[] }>(`/api/paths/${encodeURIComponent(name)}`)
      .then(data => {
        setDescription(data.description);
        setSteps(data.steps.map((s: any) => ({
          id: s.id ?? "",
          type: s.type ?? "worker",
          label: s.label ?? "",
          prompt: s.prompt ?? "",
          skills: s.skills ?? [],
          sandbox: s.sandbox ?? "read-write",
          result_file: s.result_file ?? "",
          result_key: s.result_key ?? "",
          on_success: s.on_success ?? "",
          on_failure: s.on_failure ?? "",
          max_retries: s.max_retries ?? 0,
        })));
      })
      .catch(() => {});
  }, [name]);

  const updateStep = (idx: number, patch: Partial<StepDraft>) => {
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
  };

  const removeStep = (idx: number) => {
    setSteps(prev => prev.filter((_, i) => i !== idx));
    if (expandedStep === idx) setExpandedStep(null);
    else if (expandedStep !== null && expandedStep > idx) setExpandedStep(expandedStep - 1);
  };

  const addStep = () => {
    setSteps(prev => [...prev, emptyStep()]);
    setExpandedStep(steps.length);
  };

  const handleDragStart = (idx: number) => { dragIdx.current = idx; };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    setSteps(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx.current!, 1);
      next.splice(idx, 0, moved);
      dragIdx.current = idx;
      return next;
    });
  };

  const handleDragEnd = () => { dragIdx.current = null; };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: name ? undefined : pathName.trim(),
      description,
      steps: steps.map(s => {
        const step: Record<string, any> = { id: s.id, type: s.type };
        if (s.label.trim()) step.label = s.label;
        if (s.prompt.trim()) step.prompt = s.prompt;
        if (s.skills.length > 0) step.skills = s.skills;
        if (s.sandbox !== "read-write") step.sandbox = s.sandbox;
        if (s.result_file.trim()) step.result_file = s.result_file;
        if (s.result_key.trim()) step.result_key = s.result_key;
        if (s.on_success.trim()) step.on_success = s.on_success;
        if (s.on_failure.trim()) step.on_failure = s.on_failure;
        if (s.max_retries > 0) step.max_retries = s.max_retries;
        return step;
      }),
    };
    try {
      if (name) {
        await api(`/api/paths/${encodeURIComponent(name)}`, {
          method: "PUT", body: JSON.stringify(body),
        });
      } else {
        await api("/api/paths", { method: "POST", body: JSON.stringify(body) });
      }
      onSave();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const stepIds = steps.map(s => s.id).filter(Boolean);

  const inputCls = "w-full bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/50";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{name ? `Edit: ${name}` : "New Path"}</h3>
        <button onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-400">Cancel</button>
      </div>

      {/* Path name (only for new paths) */}
      {!name && (
        <input
          type="text" value={pathName}
          onChange={e => setPathName(e.target.value)}
          placeholder="Path name (e.g. my-workflow)"
          className={`${inputCls} rounded-lg px-3 py-2 text-sm`}
        />
      )}

      {/* Description */}
      <input
        type="text" value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Path description"
        className={`${inputCls} rounded-lg px-3 py-2 text-sm`}
      />

      {/* Live preview */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-3">
        <div className="text-[10px] text-zinc-600 uppercase mb-2">Preview</div>
        <PipelinePreview steps={steps.filter(s => s.id.trim())} />
      </div>

      {/* Step list */}
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div
            key={i}
            draggable
            onDragStart={() => handleDragStart(i)}
            onDragOver={e => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
            className="bg-zinc-900/50 border border-zinc-800 rounded-lg"
          >
            {/* Step header */}
            <div
              className="flex items-center gap-2 px-3 py-2 cursor-pointer"
              onClick={() => setExpandedStep(expandedStep === i ? null : i)}
            >
              <span className="text-zinc-600 cursor-grab" title="Drag to reorder">&#x2807;</span>
              <span className="text-xs text-zinc-500 w-5">{i + 1}</span>
              <span className="text-sm flex-1">{step.id || "(unnamed)"}</span>
              <span className="text-[10px] text-zinc-600 uppercase">{step.type}</span>
              {steps.length > 1 && (
                <button
                  onClick={e => { e.stopPropagation(); removeStep(i); }}
                  className="text-xs text-red-400/60 hover:text-red-400 ml-2"
                >&times;</button>
              )}
            </div>

            {/* Step fields (expanded) */}
            {expandedStep === i && (
              <div className="px-3 pb-3 pt-1 border-t border-zinc-800 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">ID</label>
                    <input type="text" value={step.id}
                      onChange={e => updateStep(i, { id: e.target.value })}
                      placeholder="step-id" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">Type</label>
                    <select value={step.type}
                      onChange={e => updateStep(i, { type: e.target.value as StepDraft["type"] })}
                      className={inputCls}>
                      <option value="worker">worker</option>
                      <option value="verdict">verdict</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-zinc-600 uppercase">Label</label>
                  <input type="text" value={step.label}
                    onChange={e => updateStep(i, { label: e.target.value })}
                    placeholder={step.id ? step.id.charAt(0).toUpperCase() + step.id.slice(1) : "Display name"}
                    className={inputCls} />
                </div>

                {/* Skills multi-select */}
                <div>
                  <label className="text-[10px] text-zinc-600 uppercase">Skills</label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {skills.map(skill => {
                      const selected = step.skills.includes(skill.name);
                      const suggested = skill.suggested_steps?.includes(step.id);
                      return (
                        <button key={skill.name} type="button"
                          onClick={() => updateStep(i, {
                            skills: selected
                              ? step.skills.filter(s => s !== skill.name)
                              : [...step.skills, skill.name],
                          })}
                          className={`text-[10px] px-2 py-0.5 rounded-full border ${
                            selected
                              ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400"
                              : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600"
                          }`}>
                          {skill.name}{suggested && !selected ? " \u2605" : ""}
                        </button>
                      );
                    })}
                    {skills.length === 0 && (
                      <span className="text-[10px] text-zinc-600">No skills installed</span>
                    )}
                  </div>
                </div>

                {/* Prompt */}
                <div>
                  <label className="text-[10px] text-zinc-600 uppercase">Prompt</label>
                  <textarea value={step.prompt}
                    onChange={e => updateStep(i, { prompt: e.target.value })}
                    placeholder="Worker instructions..."
                    rows={2}
                    className={`${inputCls} resize-y`} />
                </div>

                {/* Sandbox toggle */}
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-zinc-600 uppercase">Sandbox</label>
                  <button type="button"
                    onClick={() => updateStep(i, { sandbox: step.sandbox === "read-write" ? "read-only" : "read-write" })}
                    className={`text-[10px] px-2 py-0.5 rounded border ${
                      step.sandbox === "read-only"
                        ? "bg-amber-500/15 border-amber-500/30 text-amber-400"
                        : "bg-zinc-800 border-zinc-700 text-zinc-500"
                    }`}>
                    {step.sandbox}
                  </button>
                </div>

                {/* Result file + key */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">Result File</label>
                    <input type="text" value={step.result_file}
                      onChange={e => updateStep(i, { result_file: e.target.value })}
                      placeholder=".grove/result.json" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">Result Key</label>
                    <input type="text" value={step.result_key}
                      onChange={e => updateStep(i, { result_key: e.target.value })}
                      placeholder="approved" className={inputCls} />
                  </div>
                </div>

                {/* Transitions */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">On Success</label>
                    <select value={step.on_success}
                      onChange={e => updateStep(i, { on_success: e.target.value })}
                      className={inputCls}>
                      <option value="">(auto — next step)</option>
                      <option value="$done">$done</option>
                      {stepIds.filter(id => id !== step.id).map(id => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-600 uppercase">On Failure</label>
                    <select value={step.on_failure}
                      onChange={e => updateStep(i, { on_failure: e.target.value })}
                      className={inputCls}>
                      <option value="">(auto — $fail)</option>
                      <option value="$fail">$fail</option>
                      {stepIds.filter(id => id !== step.id).map(id => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Max retries */}
                <div className="w-32">
                  <label className="text-[10px] text-zinc-600 uppercase">Max Retries</label>
                  <input type="number" min={0} max={10} value={step.max_retries}
                    onChange={e => updateStep(i, { max_retries: parseInt(e.target.value) || 0 })}
                    className={inputCls} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add step button */}
      <button type="button" onClick={addStep}
        className="w-full border border-dashed border-zinc-700 rounded-lg py-2 text-xs text-zinc-500 hover:border-zinc-600 hover:text-zinc-400">
        + Add Step
      </button>

      {/* Error display */}
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Save button */}
      <button onClick={handleSave}
        disabled={saving || (!name && !pathName.trim()) || steps.length === 0}
        className="bg-emerald-500/20 text-emerald-400 px-4 py-2 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50">
        {saving ? "Saving..." : name ? "Save Changes" : "Create Path"}
      </button>
    </div>
  );
}

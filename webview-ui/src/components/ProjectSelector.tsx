import { useAppStore } from "../store";

export function ProjectSelector() {
  const { projects, selectedProjectId, selectProject, deselectProject } = useAppStore();

  if (projects.length === 0) {
    return (
      <div className="px-3 py-2 text-xs opacity-60">
        No projects found
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-input-border">
      <select
        value={selectedProjectId ?? ""}
        onChange={(e) => {
          const val = e.target.value;
          if (val) selectProject(val);
          else deselectProject();
        }}
        className="w-full px-2 py-1 text-xs rounded bg-input-bg text-input-fg border border-input-border focus:border-focus-border outline-none"
      >
        <option value="">Select a project...</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </div>
  );
}

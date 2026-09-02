export type AgentActionParameterKind = "string" | "boolean" | "choice" | "model" | "effort";

export type AgentActionParameter = {
  name: string;
  title: string;
  kind: AgentActionParameterKind;
  description?: string;
  required: boolean;
  default_value?: string;
  placeholder?: string;
  options: string[];
};

export type AgentActionDescriptor = {
  id: string;
  plugin_id: string;
  plugin_name: string;
  title: string;
  description: string;
  provider: string;
  parameters: AgentActionParameter[];
  available: boolean;
  unavailable_reason?: string;
};

import { Rpc } from "@opencode/plugin/rpc";

export const SelectelModels = Rpc.define({
  id: "selectel-models",
  methods: {
    refresh: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
});

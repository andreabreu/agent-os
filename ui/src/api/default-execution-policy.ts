import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { api } from "./client";

export interface DefaultExecutionPolicyResponse {
  defaultExecutionPolicy: IssueExecutionPolicy | null;
}

export const defaultExecutionPolicyApi = {
  getCompany: (companyId: string) =>
    api.get<DefaultExecutionPolicyResponse>(`/companies/${companyId}/default-execution-policy`),
  setCompany: (companyId: string, defaultExecutionPolicy: IssueExecutionPolicy | null) =>
    api.put<DefaultExecutionPolicyResponse>(`/companies/${companyId}/default-execution-policy`, { defaultExecutionPolicy }),
  getProject: (projectId: string) =>
    api.get<DefaultExecutionPolicyResponse>(`/projects/${projectId}/default-execution-policy`),
  setProject: (projectId: string, defaultExecutionPolicy: IssueExecutionPolicy | null) =>
    api.put<DefaultExecutionPolicyResponse>(`/projects/${projectId}/default-execution-policy`, { defaultExecutionPolicy }),
};

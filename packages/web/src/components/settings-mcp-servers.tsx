"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface McpServer {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  status: string;
  statusMessage: string | null;
  lastCheckedAt: string | null;
  toolManifest: Array<{ name: string; description: string }> | null;
  envVarKeys: string[];
}

interface EnvVarRow {
  key: string;
  value: string;
}

export function SettingsMcpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editServer, setEditServer] = useState<McpServer | null>(null);
  const [deleteServerId, setDeleteServerId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formTransport, setFormTransport] = useState<"stdio" | "http">("stdio");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formEnvVars, setFormEnvVars] = useState<EnvVarRow[]>([]);

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp-servers");
      if (res.ok) {
        setServers(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  function resetForm() {
    setFormName("");
    setFormTransport("stdio");
    setFormCommand("");
    setFormArgs("");
    setFormUrl("");
    setFormEnvVars([]);
  }

  function openCreateDialog() {
    resetForm();
    setCreateOpen(true);
  }

  function openEditDialog(server: McpServer) {
    setFormName(server.name);
    setFormTransport(server.transport as "stdio" | "http");
    setFormCommand(server.command ?? "");
    setFormArgs((server.args ?? []).join(", "));
    setFormUrl(server.url ?? "");
    // Show existing env var keys with empty values (user must re-enter to change)
    setFormEnvVars(server.envVarKeys.map((key) => ({ key, value: "" })));
    setEditServer(server);
  }

  function buildEnvVarsPayload(): Record<string, string> | undefined {
    const envVars: Record<string, string> = {};
    let hasValues = false;
    for (const row of formEnvVars) {
      if (row.key.trim() && row.value.trim()) {
        envVars[row.key.trim()] = row.value.trim();
        hasValues = true;
      }
    }
    return hasValues ? envVars : undefined;
  }

  function parseArgs(input: string): string[] {
    return input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function handleCreate() {
    const body: Record<string, unknown> = {
      name: formName,
      transport: formTransport,
    };
    if (formTransport === "stdio") {
      body.command = formCommand;
      body.args = parseArgs(formArgs);
    } else {
      body.url = formUrl;
    }
    const envVars = buildEnvVarsPayload();
    if (envVars) body.envVars = envVars;

    const res = await fetch("/api/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setCreateOpen(false);
      fetchServers();
    }
  }

  async function handleEdit() {
    if (!editServer) return;

    const body: Record<string, unknown> = {
      name: formName,
      transport: formTransport,
    };
    if (formTransport === "stdio") {
      body.command = formCommand;
      body.args = parseArgs(formArgs);
    } else {
      body.url = formUrl;
    }
    const envVars = buildEnvVarsPayload();
    if (envVars) body.envVars = envVars;

    await fetch(`/api/mcp-servers/${editServer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setEditServer(null);
    fetchServers();
  }

  async function handleDelete(serverId: string) {
    await fetch(`/api/mcp-servers/${serverId}`, { method: "DELETE" });
    setDeleteServerId(null);
    fetchServers();
  }

  async function handleTestConnection(serverId: string) {
    setTestingId(serverId);
    try {
      await fetch(`/api/mcp-servers/${serverId}/test`, { method: "POST" });
      fetchServers();
    } finally {
      setTestingId(null);
    }
  }

  async function handleDiscover(serverId: string) {
    setDiscoveringId(serverId);
    try {
      await fetch(`/api/mcp-servers/${serverId}/discover`, { method: "POST" });
      fetchServers();
    } finally {
      setDiscoveringId(null);
    }
  }

  function addEnvVar() {
    setFormEnvVars((prev) => [...prev, { key: "", value: "" }]);
  }

  function removeEnvVar(index: number) {
    setFormEnvVars((prev) => prev.filter((_, i) => i !== index));
  }

  function updateEnvVar(index: number, field: "key" | "value", val: string) {
    setFormEnvVars((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: val } : row)));
  }

  function statusBadge(server: McpServer) {
    if (server.status === "connected") {
      return (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
          Connected
        </Badge>
      );
    }
    if (server.status === "error") {
      return (
        <Badge
          className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
          title={server.statusMessage ?? "Unknown error"}
        >
          Error
        </Badge>
      );
    }
    return <Badge variant="secondary">Unknown</Badge>;
  }

  if (loading) return <p>Loading...</p>;

  const formDialog = (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="server-name">Name</Label>
        <Input
          id="server-name"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="e.g. GitHub MCP"
        />
      </div>

      <div className="space-y-2">
        <Label>Transport</Label>
        <Select
          value={formTransport}
          onValueChange={(v) => setFormTransport(v as "stdio" | "http")}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">stdio (local process)</SelectItem>
            <SelectItem value="http">HTTP (remote server)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {formTransport === "stdio" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="server-command">Command</Label>
            <Input
              id="server-command"
              value={formCommand}
              onChange={(e) => setFormCommand(e.target.value)}
              placeholder="e.g. npx"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="server-args">Arguments (comma-separated)</Label>
            <Input
              id="server-args"
              value={formArgs}
              onChange={(e) => setFormArgs(e.target.value)}
              placeholder="e.g. -y, @modelcontextprotocol/server-github"
            />
          </div>
        </>
      )}

      {formTransport === "http" && (
        <div className="space-y-2">
          <Label htmlFor="server-url">URL</Label>
          <Input
            id="server-url"
            value={formUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            placeholder="e.g. https://mcp.example.com"
          />
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Environment Variables</Label>
          <Button type="button" variant="outline" size="sm" onClick={addEnvVar}>
            Add Variable
          </Button>
        </div>
        {formEnvVars.map((row, i) => (
          <div key={i} className="flex gap-2">
            <Input
              placeholder="KEY"
              value={row.key}
              onChange={(e) => updateEnvVar(i, "key", e.target.value)}
              className="flex-1"
            />
            <Input
              type="password"
              placeholder="value"
              value={row.value}
              onChange={(e) => updateEnvVar(i, "value", e.target.value)}
              className="flex-1"
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => removeEnvVar(i)}>
              Remove
            </Button>
          </div>
        ))}
        {editServer && formEnvVars.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Leave values empty to keep existing credentials.
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>MCP Servers</CardTitle>
          <Button onClick={openCreateDialog}>Add Server</Button>
        </CardHeader>
        <CardContent>
          {servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No MCP servers configured. Add one to connect external tools to your agents.
            </p>
          ) : (
            <>
              {/* Mobile card view */}
              <div className="block lg:hidden space-y-3">
                {servers.map((server) => (
                  <div key={server.id} className="rounded border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{server.name}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {server.transport}
                        </Badge>
                        {statusBadge(server)}
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {server.transport === "stdio" ? server.command : server.url}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {server.toolManifest?.length ?? 0} tools
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      <Button variant="outline" size="sm" onClick={() => openEditDialog(server)}>
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={testingId === server.id}
                        onClick={() => handleTestConnection(server.id)}
                      >
                        {testingId === server.id ? "Testing..." : "Test"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={discoveringId === server.id}
                        onClick={() => handleDiscover(server.id)}
                      >
                        {discoveringId === server.id ? "Refreshing..." : "Refresh Tools"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteServerId(server.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Transport</TableHead>
                      <TableHead>Connection</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Tools</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {servers.map((server) => (
                      <TableRow key={server.id}>
                        <TableCell className="font-medium">{server.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{server.transport}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-[200px] truncate">
                          {server.transport === "stdio" ? server.command : server.url}
                        </TableCell>
                        <TableCell>{statusBadge(server)}</TableCell>
                        <TableCell>{server.toolManifest?.length ?? 0}</TableCell>
                        <TableCell className="space-x-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditDialog(server)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={testingId === server.id}
                            onClick={() => handleTestConnection(server.id)}
                          >
                            {testingId === server.id ? "Testing..." : "Test"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={discoveringId === server.id}
                            onClick={() => handleDiscover(server.id)}
                          >
                            {discoveringId === server.id ? "Refreshing..." : "Refresh"}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDeleteServerId(server.id)}
                          >
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add MCP Server</DialogTitle>
            <DialogDescription>
              Connect an MCP server to make its tools available to your agents.
            </DialogDescription>
          </DialogHeader>
          {formDialog}
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={!formName.trim()}>
              Add Server
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editServer} onOpenChange={(open) => !open && setEditServer(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit MCP Server</DialogTitle>
            <DialogDescription>Update the server configuration.</DialogDescription>
          </DialogHeader>
          {formDialog}
          <div className="flex justify-end">
            <Button onClick={handleEdit} disabled={!formName.trim()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteServerId}
        onOpenChange={(open) => !open && setDeleteServerId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP Server</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the server and remove its tools from all agents. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleteServerId && handleDelete(deleteServerId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { User as UserIcon, Upload, Sparkles } from "lucide-react";
import type { User } from "@shared/schema";

export default function Profile() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [handle, setHandle] = useState("");

  const { data: userData } = useQuery<{ user: User }>({
    queryKey: ["/api/user/profile"],
  });

  const user = userData?.user;

  const updateProfileMutation = useMutation({
    mutationFn: async (updates: Partial<User>) => {
      const res = await apiRequest("PATCH", "/api/user/profile", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/profile"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: "Profile updated",
        description: "Your changes have been saved.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update profile.",
        variant: "destructive",
      });
    },
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("avatar", file);

      const response = await fetch("/api/user/avatar", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Upload failed");
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user/profile"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: "Avatar updated",
        description: "Your profile picture has been uploaded.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to upload avatar.",
        variant: "destructive",
      });
    },
  });

  const generateHandleMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/user/generate-handle");
      return res.json();
    },
    onSuccess: (data: { handle: string }) => {
      setHandle(data.handle);
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      uploadAvatarMutation.mutate(file);
    }
  };

  const handleSaveHandle = () => {
    if (handle) {
      updateProfileMutation.mutate({ handle });
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Profile Settings</h1>
        <p className="text-muted-foreground">Manage your account information</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">Avatar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-6">
            <Avatar className="h-24 w-24">
              <AvatarImage src={user?.avatarUrl || undefined} />
              <AvatarFallback className="bg-primary text-primary-foreground text-2xl">
                {user?.email?.[0]?.toUpperCase() || <UserIcon className="h-10 w-10" />}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
                data-testid="input-avatar-upload"
              />
              <Button
                data-testid="button-upload-avatar"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadAvatarMutation.isPending}
                variant="outline"
              >
                <Upload className="mr-2 h-4 w-4" />
                {uploadAvatarMutation.isPending ? "Uploading..." : "Upload Photo"}
              </Button>
              <p className="text-sm text-muted-foreground">
                JPG, PNG or GIF. Max 5MB.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">Account Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-base font-semibold">
              Email
            </Label>
            <Input
              id="email"
              data-testid="input-email"
              type="email"
              value={user?.email || ""}
              disabled
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="handle" className="text-base font-semibold">
              Handle
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  @
                </span>
                <Input
                  id="handle"
                  data-testid="input-handle"
                  type="text"
                  value={handle || user?.handle || ""}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="yourhandle"
                  className="h-11 pl-7"
                />
              </div>
              <Button
                data-testid="button-generate-handle"
                onClick={() => generateHandleMutation.mutate()}
                disabled={generateHandleMutation.isPending}
                variant="outline"
              >
                <Sparkles className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <Button
            data-testid="button-save-profile"
            onClick={handleSaveHandle}
            disabled={updateProfileMutation.isPending || !handle}
            className="w-full h-11"
          >
            {updateProfileMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

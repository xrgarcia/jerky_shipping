import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { User as UserIcon, Upload, Sparkles, Check } from "lucide-react";
import type { User } from "@shared/schema";

const PRESET_COLORS = [
  { name: "Slate", value: "#475569" },
  { name: "Stone", value: "#57534e" },
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Amber", value: "#d97706" },
  { name: "Yellow", value: "#ca8a04" },
  { name: "Lime", value: "#65a30d" },
  { name: "Green", value: "#16a34a" },
  { name: "Emerald", value: "#059669" },
  { name: "Teal", value: "#0d9488" },
  { name: "Cyan", value: "#0891b2" },
  { name: "Sky", value: "#0284c7" },
  { name: "Blue", value: "#2563eb" },
  { name: "Indigo", value: "#4f46e5" },
  { name: "Violet", value: "#7c3aed" },
  { name: "Purple", value: "#9333ea" },
  { name: "Fuchsia", value: "#c026d3" },
  { name: "Pink", value: "#db2777" },
  { name: "Rose", value: "#e11d48" },
];

const DEFAULT_COLOR = "#475569";

function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

export default function Profile() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [handle, setHandle] = useState("");
  const [backgroundColor, setBackgroundColor] = useState<string>(DEFAULT_COLOR);
  const [hexInputValue, setHexInputValue] = useState<string>(DEFAULT_COLOR);
  const [skuvaultUsername, setSkuvaultUsername] = useState("");
  const [initialValuesLoaded, setInitialValuesLoaded] = useState(false);

  const { data: userData } = useQuery<{ user: User }>({
    queryKey: ["/api/user/profile"],
  });

  const user = userData?.user;

  useEffect(() => {
    if (user && !initialValuesLoaded) {
      setHandle(user.handle || "");
      const color = user.profileBackgroundColor || DEFAULT_COLOR;
      setBackgroundColor(color);
      setHexInputValue(color);
      setSkuvaultUsername(user.skuvaultUsername || "");
      setInitialValuesLoaded(true);
    }
  }, [user, initialValuesLoaded]);

  const hasUnsavedChanges = user ? (
    handle !== (user.handle || "") ||
    backgroundColor !== (user.profileBackgroundColor || DEFAULT_COLOR) ||
    skuvaultUsername !== (user.skuvaultUsername || "")
  ) : false;

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

  const handleColorSelect = (color: string) => {
    setBackgroundColor(color);
    setHexInputValue(color);
  };

  const handleHexInputChange = (value: string) => {
    setHexInputValue(value);
    if (isValidHexColor(value)) {
      setBackgroundColor(value);
    }
  };

  const handleHexInputBlur = () => {
    if (!isValidHexColor(hexInputValue)) {
      setHexInputValue(backgroundColor);
    }
  };

  const handleSaveAll = () => {
    if (!hasUnsavedChanges) {
      toast({
        title: "No changes",
        description: "There are no changes to save.",
      });
      return;
    }

    const updates: Partial<User> = {};
    
    if (handle !== (user?.handle || "")) {
      updates.handle = handle || null;
    }
    if (backgroundColor !== (user?.profileBackgroundColor || DEFAULT_COLOR)) {
      updates.profileBackgroundColor = backgroundColor;
    }
    if (skuvaultUsername !== (user?.skuvaultUsername || "")) {
      updates.skuvaultUsername = skuvaultUsername || null;
    }
    
    updateProfileMutation.mutate(updates);
  };

  const displayHandle = handle || "";

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Profile Settings</h1>
        <p className="text-muted-foreground">Manage your account information</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">Profile Header Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <div 
            className="rounded-lg p-6 flex items-center gap-4"
            style={{ backgroundColor }}
            data-testid="profile-header-preview"
          >
            <Avatar className="h-16 w-16 border-2 border-white/20">
              <AvatarImage src={user?.avatarUrl || undefined} />
              <AvatarFallback className="bg-white/20 text-white text-xl">
                {user?.email?.[0]?.toUpperCase() || <UserIcon className="h-8 w-8" />}
              </AvatarFallback>
            </Avatar>
            <div className="text-white">
              <p className="text-lg font-semibold" data-testid="text-preview-handle">
                {displayHandle ? `@${displayHandle}` : "@yourhandle"}
              </p>
              <p className="text-sm text-white/70">{user?.email || "email@example.com"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">Background Color</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose a background color for your profile header section
          </p>
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-9" data-testid="color-picker-grid">
            {PRESET_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                onClick={() => handleColorSelect(color.value)}
                className="relative h-8 w-8 rounded-md transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                style={{ backgroundColor: color.value }}
                title={color.name}
                data-testid={`button-color-${color.name.toLowerCase()}`}
              >
                {backgroundColor === color.value && (
                  <Check className="absolute inset-0 m-auto h-4 w-4 text-white" />
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="custom-color" className="text-sm font-medium whitespace-nowrap">
              Custom:
            </Label>
            <Input
              id="custom-color"
              type="color"
              value={backgroundColor}
              onChange={(e) => handleColorSelect(e.target.value)}
              className="h-9 w-16 p-1 cursor-pointer"
              data-testid="input-custom-color"
            />
            <Input
              type="text"
              value={hexInputValue}
              onChange={(e) => handleHexInputChange(e.target.value)}
              onBlur={handleHexInputBlur}
              placeholder="#475569"
              className="h-9 w-24 font-mono text-sm"
              data-testid="input-color-hex"
            />
          </div>
        </CardContent>
      </Card>

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
                  value={handle}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-semibold">SkuVault Integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Link your SkuVault account to match your picking and packing activity
          </p>
          <div className="space-y-2">
            <Label htmlFor="skuvault-username" className="text-base font-semibold">
              SkuVault Username
            </Label>
            <Input
              id="skuvault-username"
              data-testid="input-skuvault-username"
              type="text"
              value={skuvaultUsername}
              onChange={(e) => setSkuvaultUsername(e.target.value)}
              placeholder="Enter your SkuVault username"
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">
              This should match the name shown when you&apos;re assigned to wave picking sessions in SkuVault
            </p>
          </div>
        </CardContent>
      </Card>

      <Button
        data-testid="button-save-profile"
        onClick={handleSaveAll}
        disabled={updateProfileMutation.isPending || !hasUnsavedChanges}
        className="w-full h-11"
      >
        {updateProfileMutation.isPending ? "Saving..." : "Save Changes"}
      </Button>
    </div>
  );
}
